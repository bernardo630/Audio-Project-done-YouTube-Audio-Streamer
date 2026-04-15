FROM node:20-slim

# Install yt-dlp via system (more reliable than postinstall download)
RUN apt-get update && apt-get install -y python3 curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Skip yt-dlp-exec postinstall (we use the system binary above)
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Tell server.js to use the system yt-dlp binary
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

EXPOSE 3000
CMD ["node", "server.js"]
