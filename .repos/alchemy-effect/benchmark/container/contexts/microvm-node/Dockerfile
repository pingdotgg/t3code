# Node baseline MicroVM — the dumbest possible node HTTP server, built the EXACT
# same way alchemy's effectful node image is built (`dnf install -y nodejs` on
# the MicroVM base — the runtime the Lambda VMs already ship). The only
# difference from the effectful node `EffectfulNode` image is the server code: a
# raw `http.createServer` with no Effect runtime, no alchemy bootstrap, no RPC.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y nodejs && dnf clean all

WORKDIR /app
COPY server.js .

EXPOSE 8080
ENV PORT=8080
ENTRYPOINT ["node", "/app/server.js"]
