FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
      fonts-dejavu-core \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"

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
COPY package.json ./
RUN npm install --omit=dev
COPY server.cjs msg_to_json.py ./

EXPOSE 8080
CMD ["node", "server.cjs"]
