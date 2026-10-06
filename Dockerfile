FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PATH="/opt/venv/bin:${PATH}"

# Pasang Python, FFmpeg, dan yt-dlp
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        python3 \
        python3-venv \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade "yt-dlp[default]" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Salin file konfigurasi Node.js dan pasang dependensi
COPY package*.json ./
RUN npm install --omit=dev

# Salin kode aplikasi
COPY . .

# Periksa apakah program yang dibutuhkan tersedia
RUN node --version \
    && yt-dlp --version \
    && ffmpeg -version

EXPOSE 3000

CMD ["node", "server.js"]
