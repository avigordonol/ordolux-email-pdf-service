FROM node:20-slim

# OS deps: Python for .msg parsing, fonts for Unicode, CA certs
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

# Install Node deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.cjs msg_to_json.py ./

EXPOSE 8080
ENV NODE_ENV=production
# Set secret in Railway → Variables as ORDOLUX_SECRET
CMD ["node", "server.cjs"]
