# ---- Build a tiny Node+Python runtime that can parse MSG and make PDFs ----
FROM node:20-slim

# System deps (python + a unicode font so PDFs render curly quotes etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
      fonts-dejavu-core \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python venv for MSG parsing (avoids PEP 668 issues)
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"

# Python libs: extract_msg + helpers.  (striprtf is a tiny RTF->text fallback.)
RUN pip install --no-cache-dir \
      extract_msg==0.55.0 \
      olefile==0.47 \
      compressed-rtf==1.0.6 \
      chardet==5.2.0 \
      tzlocal==5.2 \
      ebcdic==1.1.1 \
      striprtf==0.0.26 \
      beautifulsoup4==4.13.5

WORKDIR /app

# Node deps (pin mailparser to a version that exists)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.cjs msg_to_json.py ./

EXPOSE 8080
CMD ["node", "server.cjs"]
