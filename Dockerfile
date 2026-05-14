FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    imagemagick \
    libgtk-3-0 \
    libnss3 \
    libasound2 \
    libxss1 \
    libgbm1 \
    libxshmfence1 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["bash", "-lc", "npm run verify && npm run test:screenshot && npm run package"]
