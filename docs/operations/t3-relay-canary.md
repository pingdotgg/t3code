# T3 relay canary

## Edge transport smoke test

Before routing a zone or relinking an environment, deploy the disposable
`workers.dev` canary. It uses the production Durable Object and forwarding core
without provisioning DNS, the API Worker, PlanetScale, Clerk, or observability
resources.

From `infra/relay`, provide Cloudflare deployment credentials plus fresh,
random values for these variables:

```text
T3_RELAY_CANARY_ENDPOINT_KEY=16-lowercase-hex-characters
T3_RELAY_CANARY_CONNECTOR_TOKEN=random-secret
T3_RELAY_CANARY_CONNECTOR_LEASE_ID=random-identifier
T3_RELAY_CANARY_CONTROL_TOKEN=random-secret
```

Deploy with a unique stage and copy its returned URL into
`T3_RELAY_CANARY_URL`:

```sh
alchemy deploy alchemy.edge-canary.run.ts --stage <unique-stage> --yes
T3_RELAY_CANARY_URL=https://<worker>.workers.dev bun scripts/test-edge-canary.mjs
```

The harness verifies HTTP request bodies, a response larger than the initial
flow-control window, text and fragmented binary WebSockets, edge-handled Effect
RPC ping/pong, hibernation and wake with the connector restored, and lease
revocation. Destroy the exact stage even if validation fails:

```sh
alchemy destroy alchemy.edge-canary.run.ts --stage <unique-stage> --yes
```

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
