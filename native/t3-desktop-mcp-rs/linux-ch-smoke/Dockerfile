FROM rust:1.85-bookworm

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential pkg-config libdbus-1-dev libx11-dev libxtst-dev libxcb1-dev \
    libxkbcommon-dev clang xvfb xauth dbus-x11 at-spi2-core at-spi2-common \
    libatk-adaptor libgail-common xterm x11-apps xdotool procps python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# edition 2024 may need newer rust - pin if needed
RUN cargo build --release

RUN mkdir -p /smoke/root/segments /smoke/root/memories/resources \
  && printf '%s\n' '{' '  "enabled": true,' '  "paused": false,' '  "appFilterMode": "exclude",' '  "apps": [],' '  "websiteFilterMode": "exclude",' '  "websites": []' '}' > /smoke/root/control.json

COPY linux-ch-smoke/run.sh /smoke/run.sh
RUN chmod +x /smoke/run.sh

ENV DISPLAY=:99
ENV GTK_MODULES=gail:atk-bridge
ENV QT_ACCESSIBILITY=1

CMD ["/smoke/run.sh"]
