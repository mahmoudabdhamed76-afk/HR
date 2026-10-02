FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=8686 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    TZ=Africa/Cairo
RUN mkdir -p /app/data
EXPOSE 8686
CMD ["node", "--experimental-sqlite", "--no-warnings", "server.js"]
