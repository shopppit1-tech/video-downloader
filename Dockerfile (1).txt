FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-venv \
    python3-dev \
    ffmpeg \
    git \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# =========================
# PYTHON ENVIRONMENT
# =========================

RUN python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -U "yt-dlp[default]" \
    bgutil-ytdlp-pot-provider

# =========================
# BGUTIL PO TOKEN PROVIDER
# =========================

RUN git clone \
    --single-branch \
    --branch 2.0.1 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    /app/bgutil

WORKDIR /app/bgutil/server

RUN npm ci && \
    npx tsc

# =========================
# MAIN APPLICATION
# =========================

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/temp

ENV NODE_ENV=production
ENV PATH="/opt/venv/bin:$PATH"

EXPOSE 3000

# Jalankan PO Token Provider
# lalu jalankan server utama
CMD ["sh", "-c", "node /app/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 & exec node /app/server.js"]
