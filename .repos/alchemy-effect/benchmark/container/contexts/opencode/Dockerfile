# The Cloudflare-container twin of `../microvm-opencode/Dockerfile`: the same
# opencode server started eagerly as the entrypoint. Cloudflare containers boot
# the image from scratch on each cold start (no memory snapshot), so this
# variant pays opencode's process startup inside every boot — the comparison
# the MicroVM snapshot variant is designed to isolate.
#
# Cloudflare builds containers for linux/amd64 and the AWS MicroVM base image
# is ARM64-only, so use plain Amazon Linux 2023 (same OS family, multi-arch).
# The base OS barely matters — opencode ships its own runtime.
FROM amazonlinux:2023

RUN dnf install -y unzip tar gzip git && dnf clean all
RUN curl -fsSL https://opencode.ai/install | bash \
  && ln -s /root/.opencode/bin/opencode /usr/local/bin/opencode

WORKDIR /workspace

ENV OPENCODE_SERVER_PASSWORD=bench

EXPOSE 8080
ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "8080"]
