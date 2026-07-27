# opencode (a real coding-agent server, ~100MB binary on a Bun runtime) started
# EAGERLY as the entrypoint. The MicroVM image build runs this entrypoint,
# waits for it to initialize, and snapshots the running memory+disk — so every
# `RunMicrovm` resumes with the opencode server already listening instead of
# paying its process startup on each boot.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y unzip tar gzip git && dnf clean all
RUN curl -fsSL https://opencode.ai/install | bash \
  && ln -s /root/.opencode/bin/opencode /usr/local/bin/opencode

WORKDIR /workspace

# The server binds 0.0.0.0, so require basic auth (username defaults to
# `opencode`). The benchmark's readiness probe presents these credentials.
ENV OPENCODE_SERVER_PASSWORD=bench

EXPOSE 8080
ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "8080"]
