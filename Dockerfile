# OrdoLux Email→PDF microservice (MSG via msgconvert -> EML -> PDF)
# This image installs msgconvert and all required Perl deps from Debian repos.

FROM node:20-slim

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# Update + install msgconvert and its common deps
# (We include extras that some distros don’t auto-pull to avoid runtime surprises.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    perl \
    libemail-outlook-message-perl \
    libemail-mime-perl \
    libemail-mime-contenttype-perl \
    libemail-sender-perl \
    libio-stringy-perl \
    libole-storage-lite-perl \
    libdatetime-format-mail-perl \
    libstring-crc32-perl \
    libmime-tools-perl \
    libfile-libmagic-perl \
    libconvert-tnef-perl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Sanity: ensure msgconvert is callable now (fail early if missing)
RUN msgconvert --help >/dev/null 2>&1 || (echo "msgconvert not available" && exit 1)

WORKDIR /app

# Install Node deps (no lockfile to avoid lock mismatch errors)
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
