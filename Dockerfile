# OrdoLux Email→PDF microservice (MSG via Python extract_msg -> EML -> PDF)

FROM node:20-slim

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# System deps: Python + pip for extract_msg; certificates for TLS
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python libs for MSG reading (pin for reproducibility)
RUN pip3 install --no-cache-dir \
    extract_msg==0.47.6 \
    olefile==0.47 \
    compressed-rtf==1.0.6 \
    chardet==5.2.0

WORKDIR /app

# Install Node deps (no lockfile to avoid lock mismatch during first deploy)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./
COPY msg2eml.py ./

EXPOSE 8080
CMD ["node", "server.js"]
