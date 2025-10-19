# ---- OrdoLux Email→PDF service (Node + Python) ----
FROM node:20-slim

# OS packages: Python (for .msg parsing), fonts for PDF text, certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    fonts-dejavu-core \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Create isolated Python env (avoids PEP 668 issues) and ensure it's first in PATH
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"

# Python deps used by msg_to_json.py (pin versions for reproducibility)
RUN pip install --no-cache-dir \
    extract-msg==0.41.2 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0

# App directory
WORKDIR /app

# Install Node deps first for better layer caching
COPY package.json ./
ENV NODE_ENV=production
RUN npm install --omit=dev

# App code
COPY server.cjs msg_to_json.py ./
COPY py/ ./py/

# Runtime config
EXPOSE 8080
CMD ["node", "server.cjs"]
