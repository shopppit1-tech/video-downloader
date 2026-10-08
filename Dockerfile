FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PATH="/opt/venv/bin:${PATH}"

# =========================
# SYSTEM DEPENDENCIES
# =========================
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        ffmpeg \
        python3 \
        python3-venv \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade "yt-dlp[default]" \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade "bgutil-ytdlp-pot-provider==2.0.1" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# =========================
# BGUTIL PO TOKEN PROVIDER
# =========================
RUN git clone \
      --single-branch \
      --branch 2.0.1 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
      /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci \
    && npx tsc

# =========================
# NODE APP DEPENDENCIES
# =========================
COPY package*.json ./

RUN npm install --omit=dev

# =========================
# APPLICATION
# =========================
COPY . .

# =========================
# CHECK INSTALLATION
# =========================
RUN node --version \
    && python3 --version \
    && yt-dlp --version \
    && ffmpeg -version \
    && node /opt/bgutil/server/build/main.js --version || true

EXPOSE 3000

# =========================
# START
# =========================
CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 & exec node server.js"]
