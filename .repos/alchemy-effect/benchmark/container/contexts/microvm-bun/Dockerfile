# Bun baseline MicroVM — the dumbest possible Bun HTTP server, built the EXACT
# same way alchemy's effectful image is built (same MicroVM base, same bun
# install via the official installer). The ONLY difference from the effectful
# `EffectfulBun` image is the server code: a raw `Bun.serve({ fetch })` with no
# Effect runtime, no alchemy bootstrap, no RPC protocol. Any time-to-usable
# gap between this and the effectful variant is the alchemy/Effect cold-start
# tax, with runtime (bun) and CPU arch (ARM_64) held constant.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y unzip tar && curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun && dnf clean all

WORKDIR /app
COPY server.js .

EXPOSE 8080
ENV PORT=8080
ENTRYPOINT ["bun", "/app/server.js"]
