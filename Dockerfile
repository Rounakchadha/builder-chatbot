FROM node:20-slim AS build
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY widget/package.json widget/package.json
# npm ci instead of npm install — installs the exact versions locked in package-lock.json rather
# than letting a dependency drift to a newer compatible version between builds (security-review
# finding, 2026-10-23). Needs package-lock.json copied in above, which plain `npm install` didn't.
RUN npm ci

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
# The demo page + prebuilt widget.js, served directly by the server itself (see index.ts's
# @fastify/static registration) so the public domain's existing Apache config (ProxyPass / -> :8091)
# works with no vhost changes needed.
COPY test-page ./test-page
# Runs as a dedicated non-root user rather than the image's default root (security-review finding,
# 2026-10-23) — limits what's reachable if the container is ever compromised. `node` user already
# exists in the official node:20-slim image; just needs ownership of what it'll actually touch.
RUN chown -R node:node /app
USER node
WORKDIR /app/server
EXPOSE 8080
CMD ["node", "dist/index.js"]
