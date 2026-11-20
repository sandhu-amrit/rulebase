FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ENV PORT=8787
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "src/lib/odm/server.ts"]
