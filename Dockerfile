FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PATH="/opt/venv/bin:${PATH}"

# =========================================================
# SYSTEM
# =========================================================

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        ffmpeg \
        python3 \
        python3-venv \
        build-essential \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade "yt-dlp[default]" \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade bgutil-ytdlp-pot-provider \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*


# =========================================================
# BGUTIL PO TOKEN PROVIDER
# =========================================================

RUN git clone \
      --depth 1 \
      --branch 2.0.2 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
      /opt/bgutil


# =========================================================
# BUILD POT SERVER
# =========================================================

RUN cd /opt/bgutil/server \
    && npm ci --omit=dev \
    && npx tsc


# =========================================================
# FORCE PLUGIN INTO A KNOWN YT-DLP PLUGIN DIRECTORY
# =========================================================

RUN mkdir -p /opt/yt-dlp-plugins \
    && cp -r /opt/bgutil/plugin/yt_dlp_plugins \
          /opt/yt-dlp-plugins/yt_dlp_plugins


# =========================================================
# NODE APP
# =========================================================

COPY package*.json ./

RUN npm install --omit=dev


# =========================================================
# APPLICATION
# =========================================================

COPY . .


# =========================================================
# CHECK INSTALLATION
# =========================================================

RUN echo "===== NODE =====" \
    && node --version \
    && echo "===== PYTHON =====" \
    && python3 --version \
    && echo "===== YT-DLP =====" \
    && yt-dlp --version \
    && echo "===== FFMPEG =====" \
    && ffmpeg -version | head -n 1 \
    && echo "===== BGUTIL PLUGIN =====" \
    && find /opt/yt-dlp-plugins/yt_dlp_plugins -maxdepth 3 -type f -print


# =========================================================
# PORT
# =========================================================

EXPOSE 3000


# =========================================================
# START
# =========================================================

CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 & exec node server.js"]
