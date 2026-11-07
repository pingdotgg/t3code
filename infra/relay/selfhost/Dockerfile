# Self-hosted T3 relay. Build from the repository root (see README.md in this directory).
FROM node:26-alpine AS build
RUN npm install -g pnpm@12.14.0 vite-plus@1.4.0
WORKDIR /repo
COPY . .
# Only the relay's dependency closure: the mobile and desktop apps are not needed here.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "t3code-relay..."
# Production dependencies only; the bundle keeps third-party packages external.
RUN pnpm --filter t3code-relay deploy --prod /deploy
RUN vp pack infra/relay/src/node.ts --format esm --platform node --root infra/relay --out-dir /out --no-dts

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    RELAY_MIGRATIONS_FOLDER=/app/migrations/postgres
COPY --from=build /deploy/node_modules /app/node_modules
COPY --from=build /out /app
COPY --from=build /repo/infra/relay/migrations/postgres /app/migrations/postgres
USER node
EXPOSE 8080
CMD ["node", "src/node.mjs"]
