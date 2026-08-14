# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.13.1

FROM node:${NODE_VERSION}-bookworm AS builder

ENV CI=true

RUN apt-get update \
  && apt-get install --yes --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /src

# Keep dependency installation cacheable when application source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/client-runtime/package.json ./packages/client-runtime/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/effect-acp/package.json ./packages/effect-acp/package.json
COPY packages/effect-codex-app-server/package.json ./packages/effect-codex-app-server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/tailscale/package.json ./packages/tailscale/package.json

RUN --mount=type=cache,id=t3-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --filter t3... --ignore-scripts

COPY . .

# Defense in depth: these paths must be removed from the context by
# .dockerignore, even when a developer has authenticated locally.
RUN test ! -e .env \
  && test ! -e .codex/auth.json \
  && test ! -e .claude.json \
  && test ! -e .claude/.credentials.json \
  && test ! -e .cursor/cli-config.json \
  && test ! -e .config/opencode \
  && test ! -e .local/share/opencode \
  && test ! -e .ssh \
  && test -z "$(find .docker-e2e-canary -type f -print -quit 2> /dev/null)"

RUN pnpm rebuild esbuild msgpackr-extract node-pty
RUN pnpm --filter @t3tools/web exec vp build
RUN pnpm --filter t3 run build:bundle \
  && cp -R apps/web/dist apps/server/dist/client
RUN pnpm --filter t3 deploy --prod --legacy /out/t3

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG T3CODE_PROVIDER_PACKAGES="@openai/codex@latest @anthropic-ai/claude-code@latest opencode-ai@latest"
ARG T3CODE_INSTALL_PROVIDERS=1
ARG T3CODE_INSTALL_CURSOR=1

LABEL org.opencontainers.image.source="https://github.com/pingdotgg/t3code"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl gh git openssh-client procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Provider CLIs must live in the container; host-installed binaries are not
# visible here. Set T3CODE_INSTALL_PROVIDERS=0 for a server-only image, or
# replace this argument with a pinned/custom package list.
RUN if [ "${T3CODE_INSTALL_PROVIDERS}" = "1" ] && [ -n "${T3CODE_PROVIDER_PACKAGES}" ]; then \
    npm install --global ${T3CODE_PROVIDER_PACKAGES}; \
  fi \
  && npm cache clean --force

# Cursor distributes its Linux CLI through its own installer rather than npm.
# Keep the executable outside HOME so it remains available when /home/node is
# backed by an existing volume. Provider updates happen by rebuilding the image.
RUN if [ "${T3CODE_INSTALL_CURSOR}" = "1" ]; then \
    mkdir -p /opt/cursor-home \
    && curl --fail --silent --show-error --location https://cursor.com/install --output /tmp/install-cursor.sh \
    && HOME=/opt/cursor-home bash /tmp/install-cursor.sh \
    && ln -s /opt/cursor-home/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
    && ln -s /opt/cursor-home/.local/bin/agent /usr/local/bin/agent \
    && rm /tmp/install-cursor.sh; \
  fi

COPY --from=builder --chown=node:node /out/t3 /opt/t3

RUN chmod +x /opt/t3/dist/bin.mjs \
  && ln -s /opt/t3/dist/bin.mjs /usr/local/bin/t3 \
  && mkdir -p /home/node/.local /home/node/.t3 /workspace \
  && chown -R node:node /home/node /workspace

ENV HOME=/home/node \
  NODE_ENV=production \
  NPM_CONFIG_PREFIX=/home/node/.local \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin \
  T3CODE_HOME=/home/node/.t3 \
  T3CODE_HOST=0.0.0.0 \
  T3CODE_NO_BROWSER=true \
  T3CODE_PORT=3773

WORKDIR /workspace
USER node

EXPOSE 3773

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3773/ > /dev/null || exit 1

ENTRYPOINT ["t3"]
CMD ["serve", "/workspace"]
