# syntax=docker/dockerfile:1

# T3 agent server for Atlas Vector (see AGENTS.md "Architecture — two backends,
# one compose"). Builds the web UI + server bundle and serves BOTH on one port:
# the server resolves its static dir to the co-located web client. Build context
# is the repo root (see docker/atlas/t3.Dockerfile.dockerignore).
#
# Single-stage on purpose: the packed server externalizes its npm deps (effect,
# node-pty, @effect/platform-node, ...), so it runs against the installed
# workspace node_modules — mirroring how it runs on a dev host. The image is
# therefore large; slimming it (pnpm deploy --prod) is a GCP follow-up.

FROM node:24-bookworm-slim

# Toolchain for the one native addon the server loads at startup (node-pty);
# git is needed at runtime for the per-deal workspace git ledgers (agent seam).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g node-gyp \
 # Agent runner backends T3 drives (same as ../vector/apps/api). They must be on
 # PATH so the Codex/Claude providers resolve and the connect flow works.
 && npm install -g @openai/codex @anthropic-ai/claude-code
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

WORKDIR /repo
COPY . .

# Install deps without running every package's native build (skips electron/
# sharp/etc.), then compile only node-pty's native module from source.
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && ( cd node_modules/.pnpm/node-pty@*/node_modules/node-pty && node-gyp rebuild )

# Web build feeds the server pack (vp pack dependsOn @t3tools/web#build). VITE_*
# vars are inlined at web build time; the browser runs on the host, so the API
# URL must be host-reachable. Co-locate web assets so resolveStaticDir finds
# dist/client/index.html.
ARG VITE_ATLAS_API_URL=http://localhost:8000
ENV VITE_ATLAS_API_URL=${VITE_ATLAS_API_URL}
ARG VITE_ATLAS_APP_NAME="Atlas Vector"
ENV VITE_ATLAS_APP_NAME=${VITE_ATLAS_APP_NAME}
ARG VITE_ATLAS_AUTOPAIR=0
ENV VITE_ATLAS_AUTOPAIR=${VITE_ATLAS_AUTOPAIR}
RUN pnpm --filter @t3tools/web run build \
 && pnpm --filter t3 run build:bundle \
 && mkdir -p apps/server/dist/client \
 && cp -r apps/web/dist/. apps/server/dist/client/

ENV NODE_ENV=production
ENV T3CODE_HOST=0.0.0.0
ENV T3CODE_PORT=3773
WORKDIR /repo/apps/server
EXPOSE 3773
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3773/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Entrypoint runs `serve` and (when ATLAS_AUTOPAIR=1) publishes a long-lived
# pairing token for the gate's auto-pair. Reads T3CODE_HOST/T3CODE_PORT from env.
CMD ["sh", "/repo/docker/atlas/t3-entrypoint.sh"]
