FROM node:20-slim
RUN apt-get update && apt-get install -y \
  build-essential python3 pkg-config \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  tesseract-ocr && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
ENV USE_OCR=true
CMD ["node", "server_full.js"]
