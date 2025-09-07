# Email→PDF microservice (MSG via msgconvert -> EML -> PDF)
FROM node:20-slim

ENV NODE_ENV=production

# Tools: msgconvert (Perl) + minimal mail libs; no heavy packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    libemail-outlook-message-perl \
    libemail-mime-perl \
    libemail-sender-perl \
    libio-stringy-perl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (no lockfile to avoid CI/lock mismatches)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
