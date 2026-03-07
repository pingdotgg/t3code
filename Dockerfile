FROM oven/bun:debian@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN bun install -g @openai/codex

WORKDIR /app

COPY package.json bun.lockb* turbo.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY scripts/ ./scripts/

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build

ENV NODE_ENV=production

EXPOSE 3773

CMD ["bun", "run", "start"]
