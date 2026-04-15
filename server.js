'use strict';

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const path    = require('path');
// Use system yt-dlp binary when available (Docker/production),
// otherwise fall back to the binary downloaded by yt-dlp-exec (local dev).
const ytDlpExecModule = require('yt-dlp-exec');
const ytDlp = process.env.YTDLP_PATH
  ? ytDlpExecModule.create(process.env.YTDLP_PATH)
  : ytDlpExecModule;

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Format selector: prefer WebM/Opus (native browser support, no FFmpeg).
// Falls back to m4a, then whatever best audio is available.
const AUDIO_FORMAT = 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio';

// Base flags shared by all yt-dlp calls.
const BASE_FLAGS = {
  noWarnings:  true,
  noCallHome:  true,
  noPlaylist:  true,
};

// ---------------------------------------------------------------------------
// In-memory CDN URL cache
// Caches the resolved CDN URL per YouTube URL for up to 5 minutes.
// This prevents a new yt-dlp invocation on every Range request the browser
// sends while seeking within the audio track.
// ---------------------------------------------------------------------------
const cdnCache = new Map(); // youtubeUrl → { data, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(youtubeUrl) {
  const entry = cdnCache.get(youtubeUrl);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cdnCache.delete(youtubeUrl); return null; }
  return entry.data;
}

function setCache(youtubeUrl, data) {
  cdnCache.set(youtubeUrl, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidYouTubeUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return false; }
  const allowed = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'];
  return ['http:', 'https:'].includes(parsed.protocol) && allowed.includes(parsed.hostname);
}

function extToMime(ext) {
  const map = {
    webm: 'audio/webm',
    m4a:  'audio/mp4',
    mp4:  'audio/mp4',
    mp3:  'audio/mpeg',
    ogg:  'audio/ogg',
    opus: 'audio/ogg; codecs=opus',
  };
  return map[ext] || 'audio/webm';
}

function classifyError(msg = '') {
  const m = msg.toLowerCase();
  if (m.includes('age-restricted'))              return { code: 403, text: 'This video is age-restricted.' };
  if (m.includes('private'))                     return { code: 403, text: 'This video is private.' };
  if (m.includes('unavailable') || m.includes('not available'))
                                                 return { code: 404, text: 'Video unavailable or removed.' };
  if (m.includes('copyright'))                   return { code: 451, text: 'Blocked due to a copyright claim.' };
  if (m.includes('no such file') || m.includes('spawn'))
                                                 return { code: 500, text: 'yt-dlp binary not found. Run: npm install' };
  return { code: 500, text: 'An unexpected error occurred. Please try again.' };
}

// ---------------------------------------------------------------------------
// GET /info?url=<youtubeUrl>
// Returns JSON: { title, author, durationSec, thumbnail }
// ---------------------------------------------------------------------------
app.get('/info', async (req, res) => {
  const { url } = req.query;

  if (!url)                    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid or unsupported YouTube URL.' });

  try {
    const info = await ytDlp(url, {
      ...BASE_FLAGS,
      dumpSingleJson: true,
    });

    res.json({
      title:       info.title,
      author:      info.uploader ?? info.channel ?? 'Unknown',
      durationSec: info.duration  ?? 0,
      thumbnail:   info.thumbnail ?? null,
    });
  } catch (err) {
    console.error('[/info]', err.message);
    const { code, text } = classifyError(err.message);
    res.status(code).json({ error: text });
  }
});

// ---------------------------------------------------------------------------
// GET /stream?url=<youtubeUrl>
// Resolves the best audio-only CDN URL via yt-dlp, then proxies bytes from
// YouTube's CDN directly to the browser — zero temporary files on disk.
// Supports Range requests so the browser's native <audio> seek bar works.
// ---------------------------------------------------------------------------
app.get('/stream', async (req, res) => {
  const { url } = req.query;

  if (!url)                    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid or unsupported YouTube URL.' });

  try {
    // 1. Resolve CDN URL (cached to avoid redundant yt-dlp calls on Range requests)
    let cached = getCached(url);

    if (!cached) {
      const info = await ytDlp(url, {
        ...BASE_FLAGS,
        dumpSingleJson: true,
        format: AUDIO_FORMAT,
      });

      if (!info.url) throw new Error('yt-dlp returned no direct CDN URL');

      cached = {
        cdnUrl:   info.url,
        mimeType: extToMime(info.ext),
        ext:      info.ext ?? 'webm',
        title:    (info.title ?? 'audio').replace(/[^\w\s-]/g, '').trim(),
        filesize: info.filesize ?? info.filesize_approx ?? null,
      };
      setCache(url, cached);
    }

    const { cdnUrl, mimeType, ext, title, filesize } = cached;

    // 2. Forward Range header (enables seeking in the <audio> element)
    const upstreamHeaders = {
      // Mimic a browser so the CDN doesn't reject us
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    // 3. Proxy from CDN → client
    const httpMod  = cdnUrl.startsWith('https') ? https : http;
    const cdnReq   = httpMod.get(cdnUrl, { headers: upstreamHeaders }, (cdnRes) => {
      // Always set our own content-type (CDN might return octet-stream)
      res.setHeader('Content-Type',        mimeType);
      res.setHeader('Accept-Ranges',       'bytes');
      res.setHeader('Content-Disposition', `inline; filename="${title}.${ext}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control',       'no-cache');

      // Forward CDN's content-length / content-range for progress bar & seeking
      if (cdnRes.headers['content-length']) res.setHeader('Content-Length', cdnRes.headers['content-length']);
      if (cdnRes.headers['content-range'])  res.setHeader('Content-Range',  cdnRes.headers['content-range']);
      if (filesize && !cdnRes.headers['content-length']) res.setHeader('Content-Length', String(filesize));

      // 206 Partial Content when serving a range, 200 otherwise
      res.status(cdnRes.statusCode === 206 ? 206 : 200);

      cdnRes.pipe(res);
    });

    cdnReq.on('error', (err) => {
      console.error('[/stream] CDN error:', err.message);
      // Invalidate cache in case the URL expired
      cdnCache.delete(url);
      if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch audio from source. Retry.' });
    });

    // Clean up if the client disconnects early (e.g. tab closed)
    req.on('close', () => cdnReq.destroy());

  } catch (err) {
    console.error('[/stream]', err.message);
    if (!res.headersSent) {
      const { code, text } = classifyError(err.message);
      res.status(code).json({ error: text });
    }
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`YouTube Audio Streamer → http://localhost:${PORT}`);
});
