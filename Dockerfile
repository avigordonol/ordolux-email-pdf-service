# Use Node 20 slim
FROM node:20-slim

# System deps (Python + fonts for PDF engines, certs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    fonts-dejavu-core \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python venv (optional but keeps things tidy)
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"
ENV PYTHON=/opt/pyenv/bin/python3

# Python deps used for MSG→EML
# NOTE: extract-msg 0.41.2 depends on olefile==0.46 (not 0.47)
RUN pip install --upgrade pip setuptools wheel && \
    pip install --no-cache-dir \
      extract-msg==0.41.2 \
      olefile==0.46 \
      compressed-rtf==1.0.6 \
      chardet==5.2.0

# App
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.cjs"]
