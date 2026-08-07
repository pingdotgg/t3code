FROM node:24.19.0-bookworm-slim

ARG VP_VERSION=0.2.2
ARG CODEX_VERSION=0.146.0
ARG CLAUDE_CODE_VERSION=2.1.220

ENV CI=1 \
    VP_NODE_MANAGER=no \
    PATH="/root/.vite-plus/bin:${PATH}"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      gh \
      git \
      openssh-client \
      python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN curl -fsSL https://vite.plus | bash \
    && vp install --frozen-lockfile \
    && vp run --filter t3 build \
    && npm install --global \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}"

ENV T3CODE_HOME=/data/t3 \
    T3CODE_WORKSPACE_DIR=/data/workspace \
    CODEX_HOME=/data/codex \
    CLAUDE_CONFIG_DIR=/data/claude

EXPOSE 10000

ENTRYPOINT ["/app/infra/render/start.sh"]
