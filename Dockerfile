FROM node:20-slim

# System dependencies required by Playwright's Chromium
RUN apt-get update && apt-get install -y \
    fonts-noto \
    fonts-noto-cjk \
    fonts-liberation \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Let Playwright download its own Chromium (matches the exact version it expects)
RUN npx playwright install chromium --with-deps

COPY src ./src

EXPOSE 8080

CMD ["node", "src/index.js"]
