# Use official Puppeteer-ready image — Chrome pre-installed, no download needed
FROM ghcr.io/puppeteer/puppeteer:21.0.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (puppeteer-core only — no Chrome download)
RUN npm install --omit=dev

# Copy source
COPY server.js ./
COPY .env.example ./

EXPOSE 3001

CMD ["node", "server.js"]
