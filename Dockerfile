# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.13.1

FROM node:${NODE_VERSION}-bookworm AS builder

ARG PNPM_VERSION=11.10.0

WORKDIR /src

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN npm install --global "pnpm@${PNPM_VERSION}"

COPY . .

# The server build already declares the web app as a task dependency. Restrict
# installation to that graph so the image builder does not download desktop,
# mobile, marketing, and infrastructure dependencies it never builds.
RUN pnpm install --frozen-lockfile --filter "@t3tools/scripts..." --filter "t3..."
RUN pnpm --filter t3 exec vp run --filter t3 build
RUN pnpm --filter t3 --prod deploy --legacy /opt/t3

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG GROK_VERSION=

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/t3
ENV USER=t3
ENV LOGNAME=t3
ENV SHELL=/bin/bash
ENV PATH=/opt/cursor/.local/bin:/opt/grok/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV NODE_ENV=production
ENV DISABLE_AUTOUPDATER=1

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gh \
    jq \
    openssh-client \
    procps \
    ripgrep \
    tini \
    zsh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@openai/codex@${CODEX_VERSION}" \
  "opencode-ai@${OPENCODE_VERSION}"

# Cursor currently distributes its Linux CLI through its installer. Keep the
# immutable program files outside HOME so the persistent runtime home only
# contains user-owned settings, sessions, and credentials.
RUN install -d /opt/cursor \
  && curl --fail --silent --show-error --location \
    https://cursor.com/install \
    --output /tmp/install-cursor.sh \
  && HOME=/opt/cursor SHELL=/bin/bash bash /tmp/install-cursor.sh \
  && rm /tmp/install-cursor.sh

# Grok's installer supports a target version and a custom binary directory.
# An empty GROK_VERSION installs the current stable release.
RUN install -d /opt/grok \
  && curl --fail --silent --show-error --location \
    https://x.ai/cli/install.sh \
    --output /tmp/install-grok.sh \
  && HOME=/opt/grok GROK_BIN_DIR=/opt/grok/.grok/bin \
    bash /tmp/install-grok.sh "${GROK_VERSION}" \
  && rm /tmp/install-grok.sh

COPY --from=builder /opt/t3 /opt/t3
RUN chmod +x /opt/t3/dist/bin.mjs \
  && ln -s /opt/t3/dist/bin.mjs /usr/local/bin/t3 \
  && userdel node \
  && groupadd --gid 1000 t3 \
  && useradd --uid 1000 --gid t3 --create-home --shell /bin/bash t3 \
  && install -d --owner=t3 --group=t3 /home/t3 /workspace

USER t3
WORKDIR /workspace

EXPOSE 3773

ENTRYPOINT ["tini", "--"]
CMD ["t3", "serve", "--host", "0.0.0.0"]
