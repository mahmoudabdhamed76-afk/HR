FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    TZ=Africa/Cairo
RUN mkdir -p /app/data
# Data folder: do not declare it inside this file (Railway refuses that).
# Railway: add persistent storage from the dashboard mounted at /app/data
# Docker/Synology: docker run -v /your/folder:/app/data ...
EXPOSE 8686
CMD ["node", "--experimental-sqlite", "--no-warnings", "server.js"]
