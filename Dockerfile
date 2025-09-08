FROM node:20-slim

# Python for .MSG parsing (extract_msg)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Create a venv and install Python libs there
RUN python3 -m venv /opt/pyenv
RUN /opt/pyenv/bin/pip install --no-cache-dir \
    extract_msg==0.55.0 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0 \
    tzlocal==5.2 \
    ebcdic==1.1.1

WORKDIR /app

# Install node deps (prod only)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js msg_to_json.py ./

ENV PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
