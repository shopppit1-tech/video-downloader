FROM node:22-bookworm-slim

WORKDIR /app

# ==============================
# SYSTEM DEPENDENCIES
# ==============================

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*


# ==============================
# YT-DLP
# ==============================

RUN pip3 install \
    --break-system-packages \
    --no-cache-dir \
    --upgrade \
    "yt-dlp[default]"


# ==============================
# DENO
# Required by yt-dlp for YouTube
# JavaScript challenge solving
# ==============================

RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL=/root/.deno
ENV PATH="/root/.deno/bin:${PATH}"


# ==============================
# VERIFY DEPENDENCIES
# ==============================

RUN deno --version
RUN yt-dlp --version
RUN ffmpeg -version


# ==============================
# NODE.JS DEPENDENCIES
# ==============================

COPY package*.json ./

RUN npm ci --omit=dev


# ==============================
# APPLICATION
# ==============================

COPY . .


# ==============================
# ENVIRONMENT
# ==============================

ENV NODE_ENV=production


# ==============================
# START SERVER
# ==============================

CMD ["node", "server.js"]
