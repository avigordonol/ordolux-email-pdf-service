FROM node:20-slim

# System deps for Python tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Isolated Python env (avoids PEP 668 issue)
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"

# Python libs for MSG parsing
RUN pip install --upgrade pip && pip install --no-cache-dir \
    extract_msg==0.55.0 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0 \
    tzlocal==5.2 \
    ebcdic==1.1.1

WORKDIR /app

# Install Node deps first for caching
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./
COPY py/ ./py/

ENV PORT=3000
CMD ["node", "server.js"]
