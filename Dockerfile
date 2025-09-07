# OrdoLux Email→PDF microservice (MSG via Python extract_msg -> EML -> PDF)
FROM node:20-slim

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# System deps: Python + venv + certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Create isolated Python env (works around PEP 668), expose as python3
RUN python3 -m venv /opt/pyenv \
 && ln -s /opt/pyenv/bin/python /opt/pyenv/bin/python3
ENV PATH="/opt/pyenv/bin:${PATH}"

# Upgrade pip inside venv and install Python libs
RUN pip install --upgrade pip \
 && pip install --no-cache-dir \
    extract_msg==0.47.6 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0

WORKDIR /app

# Install Node deps (no lockfile needed here)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./
COPY msg2eml.py ./

EXPOSE 8080
CMD ["node", "server.js"]
