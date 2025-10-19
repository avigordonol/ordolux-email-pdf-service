# Use Node 20 slim
FROM node:20-slim

# System deps (Python + fonts for PDF engines, certs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    fonts-dejavu-core \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python venv (keeps Python deps tidy)
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"
ENV PYTHON=/opt/pyenv/bin/python3

# Python deps used for MSG→EML (pin to satisfy extract-msg)
RUN pip install --upgrade pip setuptools wheel && \
    pip install --no-cache-dir \
      extract-msg==0.41.2 \
      olefile==0.46 \
      compressed-rtf==1.0.6 \
      chardet==5.2.0

WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json package-lock.json* ./

# If a lockfile exists, use npm ci; otherwise fallback to npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.cjs"]
