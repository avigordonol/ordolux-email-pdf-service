# OrdoLux Email→PDF microservice (Python venv + Node)
FROM node:20-slim

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Python + venv + certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Isolated Python env (avoids PEP 668 issues)
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"

# Python deps inside venv
# NOTE: extract_msg 0.55.0 exists on PyPI; 0.47.6 does NOT.
RUN pip install --upgrade pip && pip install --no-cache-dir \
    extract_msg==0.55.0 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0 \
    tzlocal==5.2 \
    ebcdic==1.1.1

WORKDIR /app

# Install Node deps (prod only)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./
COPY msg2eml.py ./

EXPOSE 8080
CMD ["node", "server.js"]
