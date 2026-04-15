# YouTube Audio Streamer

Aplicação Node.js que permite ouvir o áudio de qualquer vídeo do YouTube diretamente no navegador, sem baixar arquivos para o servidor ou para o computador do usuário.

## Como funciona

```
Usuário cola a URL → servidor chama yt-dlp → obtém URL do CDN do YouTube → faz proxy do áudio → navegador reproduz
```

- O áudio vai do CDN do YouTube direto para o navegador via proxy — **nenhum arquivo é salvo em disco**
- Suporta **Range requests**, então a barra de progresso e o seek do `<audio>` funcionam nativamente
- Cache em memória de 5 minutos por URL evita chamadas repetidas ao `yt-dlp` durante o seek
- Prefere formato **WebM/Opus** (suporte nativo em todos os browsers modernos, sem FFmpeg)

## Estrutura

```
AudioProject/
├── server.js          # Backend Express + proxy de áudio
├── package.json
├── Dockerfile         # Para deploy em produção (Fly.io, Railway, etc.)
├── .gitignore
└── public/
    └── index.html     # Frontend — campo de URL + player de áudio HTML5
```

## API

| Rota | Descrição | Resposta |
|---|---|---|
| `GET /` | Serve o frontend | `text/html` |
| `GET /info?url=` | Metadados do vídeo | `{ title, author, durationSec, thumbnail }` |
| `GET /stream?url=` | Stream de áudio | `audio/webm` ou `audio/mp4` |

## Pré-requisitos

- [Node.js](https://nodejs.org/) >= 18
- Sem FFmpeg — não é necessário

## Instalação e uso local

```bash
# 1. Instalar dependências (baixa o binário yt-dlp automaticamente)
npm install

# 2. Iniciar o servidor
node server.js

# 3. Abrir no navegador
# http://localhost:3000
```

Para desenvolvimento com hot-reload:

```bash
npm run dev
```

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `YTDLP_PATH` | *(binário do npm)* | Caminho para um binário `yt-dlp` do sistema (usado em produção via Docker) |

## Deploy em produção

> **Vercel não é compatível** com este projeto — funções serverless têm timeout de 10–60s e não permitem processos externos. Use uma das opções abaixo.

### Railway (recomendado)

1. Suba o código para um repositório no GitHub
2. Em [railway.app](https://railway.app), crie um novo projeto e conecte o repositório
3. Railway detecta Node.js automaticamente e roda `npm install` + `npm start`
4. URL pública gerada automaticamente

O `npm install` já baixa o binário `yt-dlp` correto para Linux — nenhuma configuração extra.

### Render.com (free tier)

1. Em [render.com](https://render.com), crie um **Web Service** conectado ao GitHub
2. Build Command: `npm install`
3. Start Command: `node server.js`

> O free tier suspende a instância após 15 min de inatividade (cold start de ~30s na primeira requisição).

### Docker / Fly.io / VPS

O projeto inclui um `Dockerfile` que instala o `yt-dlp` via sistema (mais confiável que o download do postinstall):

```bash
# Build
docker build -t audio-streamer .

# Run
docker run -p 3000:3000 audio-streamer
```

Para Fly.io:

```bash
fly launch   # detecta o Dockerfile automaticamente
fly deploy
```

## Segurança

- URLs validadas contra lista branca de hostnames do YouTube (previne SSRF)
- Apenas `http:` e `https:` são aceitos como protocolo
- Sem execução de comandos com input do usuário — a URL é passada como argumento isolado ao `yt-dlp`
- `X-Content-Type-Options: nosniff` em todas as respostas de mídia

## Limitações conhecidas

- Vídeos **privados**, com **restrição de idade** ou **bloqueados por copyright** retornam erro (comportamento esperado)
- A URL do CDN do YouTube expira em ~6 horas — o cache de 5 minutos está bem dentro desse limite
- Playlists são ignoradas (`--no-playlist`): somente o primeiro vídeo de uma URL de playlist é processado

## Dependências principais

| Pacote | Versão | Função |
|---|---|---|
| `express` | ^4.18 | Servidor HTTP |
| `cors` | ^2.8 | Headers CORS |
| `yt-dlp-exec` | ^1.0 | Wrapper Node.js para o binário `yt-dlp` |
