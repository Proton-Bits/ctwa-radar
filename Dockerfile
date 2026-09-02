FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 costuma baixar binario pronto; as ferramentas ficam aqui
# so para o caso de precisar compilar na sua arquitetura.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "src/server.js"]
