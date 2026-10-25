# Built on the agentctl desktop base image, which provides the Agent user, systemd, OpenSSH, Claude
# Code and Codex at the versions agentd is tested with, gh, Chromium with playwright-cli, and the
# desktop with VNC access, the `desktop` helper and the computer-use skill. This image adds what
# developing T3 Code needs.

FROM ghcr.io/digdir/agentctl-base:ubuntu-26.04-desktop-v0.1.0-preview.15@sha256:9d5c648da1e5d829083522d9862ad3c47bc546b94bb8523c1a5e9bd9f7e0646e

# The base ends as the unprivileged Agent user; installing packages needs root again.
USER root

# T3 Code's build tooling (ImageMagick resizes the desktop app's icons; libsecret-1-dev and
# pkg-config build its native keyring helper), libatomic1, which Node.js 26 needs, and Inter, the
# demo-video skill's font beside the base's JetBrains Mono. The containers feature adds Podman, so
# a nested agentd can build Agent images, and the `docker` command.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        build-essential \
        fonts-inter \
        imagemagick \
        libatomic1 \
        libsecret-1-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && agent-feature install containers

ARG TARGETARCH
# The checkout requires exactly this Node (package.json engines). It replaces the base's Node 24 in
# /usr/local; the harnesses and the base's global packages keep working on it.
ARG NODE_VERSION=26.12.1

RUN case "${TARGETARCH}" in \
        amd64) NODE_ARCH=x64 ;; \
        arm64) NODE_ARCH=arm64 ;; \
        *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && NODE_SHA256="$(curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/SHASUMS256.txt" \
        | awk -v filename="${NODE_ARCHIVE}" '$2 == filename { print $1 }')" \
    && test -n "${NODE_SHA256}" \
    && curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}" -o /tmp/node.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/include/node \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 --no-same-owner -C /usr/local \
        --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md \
        --exclude="node-v${NODE_VERSION}-linux-${NODE_ARCH}/include" \
    && rm -f /tmp/node.tar.xz \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && scratch="$(mktemp -d)" \
    && HOME="${scratch}" TMPDIR="${scratch}" claude --version \
    && HOME="${scratch}" TMPDIR="${scratch}" codex --version \
    && HOME="${scratch}" TMPDIR="${scratch}" playwright-cli --version \
    && rm -rf "${scratch}"

# Matches the repository's playwright-core. The web app's browser tests run headless on this
# version's Chromium build, beside the base's own one, which the desktop and playwright-cli use.
ARG PLAYWRIGHT_VERSION=1.64.1

# Agent Sandboxes mount their CA bundle at /run/agent/tls; Node trusts it only when told to.
# Playwright 1.64 does not support Ubuntu 26.04 and only downloads for it with the 24.04 build named; it
# runs that build as it is.
RUN case "${TARGETARCH}" in \
        amd64) PLAYWRIGHT_ARCH=x64 ;; \
        arm64) PLAYWRIGHT_ARCH=arm64 ;; \
        *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    if [ -r /run/agent/tls/ca-bundle.pem ]; then \
      export NODE_EXTRA_CA_CERTS=/run/agent/tls/ca-bundle.pem; \
    fi; \
    export HOME="$(mktemp -d)" \
    && PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="ubuntu24.04-${PLAYWRIGHT_ARCH}" \
        npx --yes "playwright@${PLAYWRIGHT_VERSION}" install chromium-headless-shell \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
    && rm -rf "${HOME}" /root/.npm

# agentctl and agentd of the release the base image is from, for nested Agents: nested Sandboxes,
# agentd's /dev/kvm and Podman setup, and the GitHub logins and secrets nested Agents take from
# this one. The host needs that release or later. agentd downloads its runtime on first use.
COPY --from=ghcr.io/digdir/agentctl:v0.1.0-preview.15@sha256:1bc767955b6740c4b65e402332e8099154a0da8a4a80ae8f778182647dcdf40e /agentctl /agentd /usr/local/bin/
RUN agentctl --version

COPY rootfs/ /

# agent-ssh-config-init gives T3 Code's SSH environments nested Agents' aliases.
RUN systemctl enable agent-ssh-config-init.service \
    && agent-image-check

USER agent

# Vite+ (`vp`) drives installs, dev servers and tests. Node stays the system install above.
ARG VITE_PLUS_VERSION=1.0.0
ENV VP_HOME=/home/agent/.vite-plus
RUN if [ -r /run/agent/tls/ca-bundle.pem ]; then \
      export NODE_EXTRA_CA_CERTS=/run/agent/tls/ca-bundle.pem; \
    fi; \
    curl -fsSL https://vite.plus -o /tmp/vite-plus-install.sh \
    && CI=1 VP_NODE_MANAGER=no VP_VERSION="${VITE_PLUS_VERSION}" bash /tmp/vite-plus-install.sh </dev/null \
    && rm -f /tmp/vite-plus-install.sh \
    && /home/agent/.vite-plus/bin/vp --version

# Rust builds the desktop app's native helpers under native/, whose edition 2024 needs a newer
# toolchain than Ubuntu ships. Sessions take PATH from ~/.profile rather than the image, so rustup
# adds itself there and to ~/.bashrc, as the Vite+ installer does.
ARG RUSTUP_VERSION=1.29.1
ARG RUST_VERSION=1.99.0
RUN case "${TARGETARCH}" in \
        amd64) RUST_ARCH=x86_64; \
            RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71 ;; \
        arm64) RUST_ARCH=aarch64; \
            RUSTUP_SHA256=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433 ;; \
        *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUST_ARCH}-unknown-linux-gnu/rustup-init" \
        -o /tmp/rustup-init \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && rm -f /tmp/rustup-init \
    && grep -q cargo/env /home/agent/.profile \
    && /home/agent/.cargo/bin/cargo --version
ENV PATH=/home/agent/.local/bin:/home/agent/.cargo/bin:/home/agent/.vite-plus/bin:${PATH}

WORKDIR /home/agent/code
