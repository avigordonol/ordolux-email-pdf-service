FROM node:18-bullseye

# Tools:
# - msgconvert (.msg -> .eml)
# - wkhtmltopdf (HTML -> PDF)
# - LibreOffice (Office -> PDF)
# - ImageMagick (images -> PDF)
# - poppler-utils (pdfunite to merge PDFs)
RUN apt-get update &&     apt-get install -y --no-install-recommends       libemail-outlook-message-perl       libemail-mime-perl       libemail-sender-perl       libio-stringy-perl       wkhtmltopdf       libreoffice       imagemagick       poppler-utils       ca-certificates &&     rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./

ENV PORT=8080
ENV MAX_BYTES=26214400
CMD ["node","server.js"]
