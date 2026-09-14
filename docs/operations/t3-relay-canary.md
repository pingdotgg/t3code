# T3 relay canary

## Edge transport smoke test

Before routing a zone or relinking an environment, run the disposable canary.
It uses the production Durable Object and forwarding core without provisioning
DNS, the API Worker, PlanetScale, Clerk, or observability resources. The
canary has no wildcard hostname, so it addresses endpoints by path:
`/u/<userKey>/e/<endpointKey>/...`.

From `infra/relay`, export a fresh random control token. Both the Worker and
the harness read it from the environment:

```sh
export T3_RELAY_CANARY_CONTROL_TOKEN=random-secret
```

For a local run, no Cloudflare credentials are needed beyond placeholder
values that satisfy the provider's environment check. `alchemy dev` stays in
the foreground and hot-reloads, so run it in a second terminal or in the
background:

```sh
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 CLOUDFLARE_API_TOKEN=local \
  alchemy dev alchemy.edge-canary.run.ts --stage canary-local &
T3_RELAY_CANARY_URL=http://localhost:1337 T3_RELAY_CANARY_FAST=1 \
  bun scripts/test-edge-canary.mjs
```

For a deployed run, provide real Cloudflare credentials, deploy with a unique
stage, and copy its returned URL into `T3_RELAY_CANARY_URL`:

```sh
alchemy deploy alchemy.edge-canary.run.ts --stage <unique-stage> --yes
T3_RELAY_CANARY_URL=https://<worker>.workers.dev bun scripts/test-edge-canary.mjs
```

The harness links two users, one with two environments on the same hub object
and one on its own, and verifies routing, isolation between endpoints and
between objects, credential scoping, concurrent traffic, HTTP request bodies,
a response larger than the initial flow-control window, text and fragmented
binary WebSockets, edge-handled Effect RPC ping/pong, relinking one endpoint
while a sibling's client stays connected, and revoking one endpoint without
affecting the other. The harness reads from the objects whether the two users
landed on the same hub and adjusts its isolation checks, so it is valid for
any `RELAY_HUB_SHARD_COUNT`. Start the Worker with `RELAY_HUB_SHARD_COUNT=1`
and run the harness with `T3_RELAY_CANARY_SHARED_HUB=1` to require the
shared-object case. Without `T3_RELAY_CANARY_FAST` it also covers the slow
reader, abandoned download, and hibernation checks, which take several
minutes and only mean something on real Cloudflare infrastructure. Destroy the
exact stage even if validation fails:

```sh
alchemy destroy alchemy.edge-canary.run.ts --stage <unique-stage> --yes
```

To attach a real local T3 server instead of the harness origins, use
`scripts/connect-edge-canary.mjs`; it prints the public URL prefix to open.

The canary control routes are protected by the control token and exist only in
the disposable canary Worker. They are not part of the production edge Worker.

## Provider canary

Keep `RELAY_MANAGED_ENDPOINT_PROVIDER=cloudflare_tunnel` for the normal
deployment. Deploy the edge Worker, first-level wildcard DNS record, and
stage-suffix Worker route first, then verify the route without changing
provider selection. Confirm existing explicit tunnel CNAMEs still resolve to
their tunnels before enabling a canary. The `prod` zone-owner stack owns the
shared wildcard record; deploy it before a non-production canary stack.

For a canary relay deployment, set:

```text
RELAY_MANAGED_ENDPOINT_PROVIDER=t3_relay
```

Relink only designated test environments. A capable host advertises both
providers and receives a `t3_relay` runtime configuration; older hosts remain on
Cloudflare Tunnel. Use separate control and canary environments (or separate
relay stages) to compare the transports in parallel. Existing Cloudflare
allocations are retained for rollback, but the selected environment runtime
runs only one connector, so the old endpoint is not a live traffic mirror. Do
not send the same mutation to both transports.

Validate, in order:

1. the built-in connector reports `providerKind: t3_relay`;
2. the connector exchanges its configured credential for a one-time ticket and
   establishes the edge WebSocket without putting the configured credential in
   the URL; confirm a `T3 relay connector connected` log and investigate any
   categorized retry logs;
3. relay status succeeds through the new edge hostname;
4. credential minting succeeds through the new hostname;
5. one web or mobile WebSocket session can reconnect after the host connector
   is interrupted;
6. relinking the environment supersedes the old connector, and a release using
   the old connector lease returns `ok: false` without disconnecting the new
   connector;
7. HTTP and WebSocket traffic remain isolated to the intended environment.

Rollback by restoring
`RELAY_MANAGED_ENDPOINT_PROVIDER=cloudflare_tunnel` and relinking the canary
environment. Unlinking revokes the T3 connector and removes any retained
Cloudflare allocation. Do not remove the wildcard Worker route until no active
links advertise a T3 relay endpoint.
