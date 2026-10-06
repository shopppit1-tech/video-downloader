FROM node:22-bookworm-slim

WORKDIR /app

# Install Python, FFmpeg dan tools dasar
RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-venv \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Buat virtual environment Python
RUN python3 -m venv /opt/venv

# Install yt-dlp + EJS resmi
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir -U "yt-dlp[default]"

# Jadikan yt-dlp tersedia sebagai command
ENV PATH="/opt/venv/bin:$PATH"

# Install dependency Node
COPY package*.json ./
RUN npm install --omit=dev

# Copy seluruh aplikasi
COPY . .

# Folder temporary
RUN mkdir -p /app/temp

# Port Render
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
