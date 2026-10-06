FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV TWILL_DOCUMENTS_DIR=/documents
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/registry/server.ts"]
