# T3 relay transport

T3 relay is a managed-endpoint provider that can run beside the existing
Cloudflare Tunnel provider. It preserves the client-facing contract: web,
desktop, and mobile clients still use an ordinary HTTPS base URL and WebSocket
URL. The provider choice changes only the link challenge, provisioned runtime
configuration, and host connector.

## Topology

Each endpoint is an opaque first-level hostname with a stage-specific suffix,
for example `<endpointKey>-<userKey>-t3r-stage.example.com`. Keeping endpoints
at the first subdomain level lets a full-setup Cloudflare zone use Universal
SSL without requiring Total TLS or an advanced certificate. A suffix-specific
Worker route and a proxied wildcard DNS record map the hostname to a
hibernating Durable Object.

One Durable Object, the hub, serves every endpoint of one user. The `userKey`
in the hostname names the hub; the `endpointKey` names the environment inside
it. Both keys are stage-scoped SHA-256 prefixes, so the edge never needs the
relay database to route. The hub keeps per-endpoint state under prefixed
storage keys (`endpoint:<key>:configuration`, `:ticket`, `:activeSession`) and
per-endpoint in-memory tables for the connector socket, client sockets, and
pending HTTP requests. Stream ids are scoped to an endpoint because every
frame travels over that endpoint's own connector socket. Hibernatable socket
attachments carry the endpoint key, so a wake-up rebuilds the tables from the
attachments plus one batched storage read of the leases it needs. The object
drops an endpoint's tables once it has no connector, clients, or pending
requests, so a long-lived hub does not retain every endpoint it has served.

The hub is bounded by `RELAY_TRANSPORT_MAX_OBJECT_CONNECTORS` live connectors
and `RELAY_TRANSPORT_MAX_OBJECT_STREAMS` public streams on top of the
per-endpoint stream cap. `RELAY_HUB_SHARD_COUNT` optionally spreads users over
a fixed number of hubs instead of one per user. Changing it after rollout moves
every user to a different object, which strands configured connectors until
their hosts relink, so treat it as a deployment constant. The trade is
per-user isolation against object count. One hub per user is the default
because it keeps one noisy user's stream cap from affecting another and it
still lets a future single client socket reach all of that user's
environments through one object.

The host opens one authenticated WebSocket per endpoint to the hub and
multiplexes HTTP and WebSocket streams over binary protocol frames. The host
connector forwards those streams to the same loopback T3 server used by
cloudflared.

The API Worker configures and revokes endpoint connector tokens over a private
Worker service binding, addressed by `{ userKey, endpointKey }`. Public
requests cannot invoke that control surface.
The host exchanges its long-lived connector token in an authenticated POST for
a 30-second, single-use ticket. Only that ticket appears in the WebSocket query,
and the edge removes it before forwarding the upgrade to the Durable Object.
Issuing a newer ticket invalidates an unused older ticket for that endpoint.
A ticket or token for one endpoint is never accepted by a sibling endpoint on
the same hub.
Each provisioning also receives a unique connector lease derived from the link
challenge. The lease is stored with the environment link and runtime config.
Configure replaces the active lease and disconnects its old connector; release
and unlink revoke only when their expected lease still matches. This prevents a
slow shutdown or unlink from revoking a connector installed by a concurrent
relink. Revoking one endpoint leaves the other endpoints on the hub untouched.

Protocol metadata is schema checked. Binary bodies use bounded 64 KiB frames;
WebSocket messages are fragmented and reassembled up to a 16 MiB message limit.
Incomplete messages share a 16 MiB aggregate buffer and each message is limited
to 1,024 non-empty fragments, preventing many sparse streams from retaining
unbounded memory. Every fragment after the first carries a continuation flag.
Partial messages live only in memory, so a Durable Object that hibernates
between fragments loses them; the flag lets the receiver drop the stream
instead of forwarding the tail as a complete message.
The edge reads HTTP request bodies incrementally and rejects them above 16 MiB;
the built-in connector buffers at most that same limit before calling the
loopback origin. HTTP responses stream back to the edge using per-stream credit
updates with a 256 KiB initial window, so a slow public client cannot create an
unbounded response queue in the Durable Object. An in-flight response keeps the
object awake and billed, so the body stream aborts after 60 seconds with no
chunk consumed. A slow client that keeps reading is unaffected; an abandoned
download is released. A stuck object costs about $4 a month, so this bound is
the main guard against it. Ticket and WebSocket connection
attempts have bounded deadlines, and reconnects use jittered exponential
backoff. Connector attachments carry a unique
session identity; restoration checks both that identity and the persisted lease
so a closing, superseded socket cannot become active after wake-up. In-flight
HTTP requests keep their Durable Object invocation active and therefore do not
depend on in-memory restoration. The host does not report the connector ready
until it receives the schema-validated, versioned `connector_ready` frame from
the object. The Durable Object answers Effect RPC's fixed
`{"_tag":"Ping"}` message with `{"_tag":"Pong"}` through Cloudflare's
WebSocket auto-response facility. Idle T3 clients therefore keep their sockets
healthy without waking the object or forwarding heartbeat traffic to the host.

## Provider negotiation

Hosts advertise the managed endpoint providers they understand when requesting
a link challenge. A missing advertisement means a legacy, Cloudflare-only host.
The relay selects a provider only when both the deployment preference and the
host capability allow it. A legacy host still falls back to
`cloudflare_tunnel`; an explicit capability list that excludes the preferred
provider fails the challenge instead of returning unusable connector
configuration.

`RELAY_MANAGED_ENDPOINT_PROVIDER` controls the deployment preference and
defaults to `cloudflare_tunnel`. Changing it affects new link reconciliations;
it does not silently rewrite existing links.

Cloudflare and T3 relay endpoints use different hostnames. If an environment
already has a Cloudflare allocation, selecting T3 relay does not delete that
allocation, which keeps rollback cheap. The environment runtime still runs only
the selected connector, so control and canary traffic must use different test
environments (or separate relay stages). A retained endpoint is not a second
live mirror, and state-changing requests must never be mirrored automatically.

## Current constraints

- HTTP request bodies are bounded at 16 MiB in the host connector. Large uploads
  need credit-based streaming before this provider is suitable for them.
- Request-body flow control is not implemented yet; the 16 MiB request cap is
  the bound until uploads are streamed through to the loopback origin.
- The connector path `/.well-known/t3-relay/connect` is reserved by the edge.
  WebSocket handshake status, subprotocols, and arbitrary upgrade headers are
  not transparently proxied. T3 clients authenticate through their existing
  query ticket, so the current T3-only transport does not depend on those
  generic reverse-proxy features.
- The exact Effect RPC ping message is consumed by the edge auto-response. A
  future generic tunnel product would need to scope or remove that behavior.
- The edge canary remains a release gate for Cloudflare's WebSocket
  auto-response, hibernation, and streaming behavior; unit tests cover
  negotiation, framing, routing, provisioning, runtime selection, and host
  forwarding. `alchemy dev` runs the same canary in local workerd, which is
  enough for routing, isolation, and relink checks but not for hibernation
  timing.
- The host still opens one connector socket per environment and clients still
  open one socket per environment. Collapsing a user's client sockets into one
  hub connection is possible now that the hub owns all of that user's
  endpoints, but it needs a client-side multiplexing protocol and is not part
  of this transport.

These constraints are why the provider remains opt-in rather than the default.
