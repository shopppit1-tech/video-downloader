FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install \
    --break-system-packages \
    --no-cache-dir \
    --upgrade \
    "yt-dlp[default]"

RUN node --version && \
    yt-dlp --version && \
    ffmpeg -version

COPY package.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "server.js"]
