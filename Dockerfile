FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PATH="/opt/venv/bin:${PATH}"

# =====================================================
# SYSTEM DEPENDENCIES
# =====================================================

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        ffmpeg \
        git \
        ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --upgrade pip \
    && /opt/venv/bin/python -m pip install --no-cache-dir -U "yt-dlp[default]" \
    && /opt/venv/bin/python -m pip install --no-cache-dir -U bgutil-ytdlp-pot-provider \
    && rm -rf /var/lib/apt/lists/*


# =====================================================
# BGUTIL SERVER
# =====================================================

RUN git clone \
    --depth 1 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    /opt/bgutil

RUN cd /opt/bgutil/server \
    && npm ci --omit=dev \
    && npx tsc


# =====================================================
# NODE APP
# =====================================================

COPY package*.json ./

RUN npm install --omit=dev


# =====================================================
# APP
# =====================================================

COPY . .


# =====================================================
# CHECK
# =====================================================

RUN echo "===== NODE =====" \
    && node --version \
    && echo "===== YT-DLP =====" \
    && yt-dlp --version \
    && echo "===== FFMPEG =====" \
    && ffmpeg -version | head -n 1 \
    && echo "===== BGUTIL =====" \
    && test -f /opt/bgutil/server/build/main.js \
    && echo "BGUTIL SERVER OK"


# =====================================================
# PORT
# =====================================================

EXPOSE 3000


# =====================================================
# START POT + APP
# =====================================================

CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 & exec node server.js"]
