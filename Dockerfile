# The bot only. Ollama runs on the host (Docker Desktop can't give containers
# the AMD GPU); Postgres and the reranker are their own compose services.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# Bring the schema up to date, then start polling Bale.
CMD ["sh", "-c", "npm run migrate:up && npm start"]
