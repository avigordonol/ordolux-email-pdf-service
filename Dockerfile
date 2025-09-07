FROM node:20-slim

# Tools to convert .msg -> .eml (msgconvert) and TLS certs
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libemail-outlook-message-perl \
      libemail-mime-perl \
      libemail-sender-perl \
      libio-stringy-perl \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only package.json first → faster layer caching
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]
