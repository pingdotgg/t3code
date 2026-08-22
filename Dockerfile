FROM node:24-bookworm-slim AS t3-install

ARG T3_VERSION=latest

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    g++ \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install \
    --no-audit \
    --no-fund \
    --omit=dev \
    --prefix /opt/t3 \
    "t3@${T3_VERSION}"

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /workspace \
  && chown node:node /data /workspace \
  && git config --system --add safe.directory /workspace

COPY --from=t3-install --chown=node:node /opt/t3 /opt/t3

ENV PATH="/opt/t3/node_modules/.bin:${PATH}" \
  T3CODE_HOME=/data

USER node
WORKDIR /workspace

EXPOSE 3773
VOLUME ["/data", "/workspace"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["t3", "serve", "--auto-bootstrap-project-from-cwd", "--host", "0.0.0.0", "--port", "3773", "/workspace"]
