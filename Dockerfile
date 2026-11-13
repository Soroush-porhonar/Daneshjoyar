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

# Bring the schema up to date, then start polling Bale. `exec node` makes the
# bot process PID 1, so `docker stop` (SIGTERM) reaches it and it can shut
# down gracefully; through npm and sh the signal never arrived.
CMD ["sh", "-c", "npm run migrate:up && exec node --import tsx src/main.ts"]
