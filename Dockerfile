FROM node:18-bullseye

# Tools for conversions
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libemail-outlook-message-perl \
      libemail-mime-perl \
      libemail-sender-perl \
      libio-stringy-perl \
      wkhtmltopdf \
      libreoffice \
      imagemagick \
      poppler-utils \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only package.json so we don't enforce a lockfile match
COPY package.json ./

# Install production deps
RUN npm install --omit=dev

# Copy the app code
COPY server.js ./

ENV PORT=8080
ENV MAX_BYTES=26214400
CMD ["node","server.js"]
