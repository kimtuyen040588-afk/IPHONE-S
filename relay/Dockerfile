FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY src ./src
USER node
EXPOSE 4310
CMD ["node", "src/server.mjs"]
