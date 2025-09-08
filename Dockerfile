FROM node:20-slim

# OS deps: python for .msg parsing + unicode fonts for PDF
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    fonts-dejavu-core \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Python venv for extract_msg
RUN python3 -m venv /opt/pyenv
RUN /opt/pyenv/bin/pip install --no-cache-dir \
    extract_msg==0.55.0 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0 \
    tzlocal==5.2 \
    ebcdic==1.1.1

WORKDIR /app

# Install Node deps first (better caching)
COPY package.json ./

# Force the official npm registry and show what it is (for logs)
RUN npm config set registry https://registry.npmjs.org/ \
 && echo "npm registry:" $(npm config get registry) \
 && npm install --omit=dev --no-audit --prefer-online

# App code
COPY server.cjs msg_to_json.py ./

EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.cjs"]
