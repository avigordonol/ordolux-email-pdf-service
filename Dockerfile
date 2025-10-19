FROM node:20-slim

# System deps: Python + Chromium + fonts + certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    chromium \
    fonts-dejavu-core fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python venv and MSG deps
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"
ENV PYTHON=/opt/pyenv/bin/python3
RUN pip install --upgrade pip setuptools wheel && \
    pip install --no-cache-dir \
      extract-msg==0.41.2 \
      olefile==0.46 \
      compressed-rtf==1.0.6 \
      chardet==5.2.0

WORKDIR /app

# Install Node deps (fallback to npm install if no lockfile)
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copy app code
COPY . .

ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium

EXPOSE 3000
CMD ["node", "server.cjs"]
