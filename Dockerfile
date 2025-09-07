FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Only package.json -> install -> then copy code (faster layer caching)
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
