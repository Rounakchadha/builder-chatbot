FROM node:20-slim AS build
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY widget/package.json widget/package.json
RUN npm install

COPY shared shared
COPY server server
RUN npm run build --workspace shared
RUN npx prisma generate --schema server/prisma/schema.prisma
RUN npm run build --workspace server

FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
WORKDIR /app/server
EXPOSE 8080
CMD ["node", "dist/index.js"]
