FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
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
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Deno adalah runtime JavaScript yang direkomendasikan yt-dlp untuk YouTube.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh && \
    deno --version

# PYTHON ENVIRONMENT
RUN python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH"
ENV NODE_ENV=production

# Pasang yt-dlp nightly, dependensi default termasuk yt-dlp-ejs,
# dan plugin BGUtil PO Token.
RUN python3 -m pip install --no-cache-dir --upgrade pip && \
    python3 -m pip install --no-cache-dir --upgrade --pre \
    "yt-dlp[default]" \
    bgutil-ytdlp-pot-provider && \
    yt-dlp --version

# BGUTIL PO TOKEN PROVIDER
RUN git clone \
    --single-branch \
    --branch 2.0.1 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    /app/bgutil

WORKDIR /app/bgutil/server

# Gunakan compiler TypeScript langsung agar tidak menjalankan paket "tsc" yang salah.
RUN npm install --include=dev && \
    npm install --no-save typescript && \
    node ./node_modules/typescript/bin/tsc

# MAIN APPLICATION
WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/temp

EXPOSE 3000

CMD ["sh", "-c", "node /app/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 & exec node /app/server.js"]
