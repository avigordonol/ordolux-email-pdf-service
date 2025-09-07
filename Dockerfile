# OrdoLux Email→PDF microservice (Python venv + Node)
FROM node:20-slim

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Python + venv (PEP 668-safe) + certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Create isolated Python env (no global pip), add it to PATH
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"

# Python deps inside venv
RUN pip install --upgrade pip && pip install --no-cache-dir \
    extract_msg==0.47.6 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0

WORKDIR /app

# Install Node deps (prod only)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./
COPY msg2eml.py ./

EXPOSE 8080
CMD ["node", "server.js"]
