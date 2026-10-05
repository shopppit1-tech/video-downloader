FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    && apt-get purge -y python3-pip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public
RUN mkdir -p temp && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "start"]
