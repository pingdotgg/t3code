FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV npm_config_registry=https://registry.npmmirror.com
ENV ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ENV ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @t3tools/web build \
  && pnpm --filter t3 build:bundle \
  && cp -R apps/web/dist apps/server/dist/client

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV T3CODE_HOST=0.0.0.0
ENV T3CODE_PORT=3773
ENV T3CODE_NO_BROWSER=true
ENV T3CODE_HOME=/var/lib/t3code

WORKDIR /app
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules

RUN useradd --system --uid 10001 --home-dir /var/lib/t3code --create-home t3code \
  && chown -R t3code:t3code /var/lib/t3code
USER t3code

EXPOSE 3773
VOLUME ["/var/lib/t3code"]
CMD ["node", "apps/server/dist/bin.mjs", "serve"]
