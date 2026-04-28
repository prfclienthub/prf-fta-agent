FROM ghcr.io/puppeteer/puppeteer:21.0.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY .env.example ./

# Railway sets PORT automatically — expose it
EXPOSE $PORT

CMD ["node", "server.js"]
