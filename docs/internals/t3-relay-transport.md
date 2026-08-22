# T3 relay transport

T3 relay is a managed-endpoint provider that can run beside the existing
Cloudflare Tunnel provider. It preserves the client-facing contract: web,
desktop, and mobile clients still use an ordinary HTTPS base URL and WebSocket
URL. The provider choice changes only the link challenge, provisioned runtime
configuration, and host connector.

## Topology

Each endpoint is an opaque first-level hostname with a stage-specific suffix,
for example `<hash>-t3r-stage.example.com`. Keeping endpoints at the first
subdomain level lets a full-setup Cloudflare zone use Universal SSL without
requiring Total TLS or an advanced certificate. A suffix-specific Worker route
and a proxied wildcard DNS record map the hostname to one hibernating Durable
Object. Existing explicit Cloudflare Tunnel CNAMEs remain more specific than
the wildcard record. The host opens one authenticated WebSocket to the object
and multiplexes HTTP and WebSocket streams over binary protocol frames. The
host connector forwards those streams to the same loopback T3 server used by
cloudflared.

The API Worker configures and revokes endpoint connector tokens over a private
Worker service binding. Public requests cannot invoke that control surface.
The host exchanges its long-lived connector token in an authenticated POST for
a 30-second, single-use ticket. Only that ticket appears in the WebSocket query,
and the edge removes it before forwarding the upgrade to the Durable Object.
Issuing a newer ticket invalidates an unused older ticket for that endpoint.
Each provisioning also receives a unique connector lease derived from the link
challenge. The lease is stored with the environment link and runtime config.
Configure replaces the active lease and disconnects its old connector; release
and unlink revoke only when their expected lease still matches. This prevents a
slow shutdown or unlink from revoking a connector installed by a concurrent
relink.

Protocol metadata is schema checked. Binary bodies use bounded 64 KiB frames;
WebSocket messages are fragmented and reassembled up to a 16 MiB message limit.
Incomplete messages share a 16 MiB aggregate buffer and each message is limited
to 1,024 non-empty fragments, preventing many sparse streams from retaining
unbounded memory.
The edge reads HTTP request bodies incrementally and rejects them above 16 MiB;
the built-in connector buffers at most that same limit before calling the
loopback origin. HTTP responses stream back to the edge using per-stream credit
updates with a 256 KiB initial window, so a slow public client cannot create an
unbounded response queue in the Durable Object. Ticket and WebSocket connection
attempts have bounded deadlines, and reconnects use jittered exponential
backoff. Hibernatable socket attachments restore connector and client roles
after a Durable Object wake-up. Connector attachments also carry a unique
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
- The deployed edge canary remains a release gate for Cloudflare's WebSocket
  auto-response, hibernation, and streaming behavior; unit tests cover
  negotiation, framing, routing, provisioning, runtime selection, and host
  forwarding.

These constraints are why the provider remains opt-in rather than the default.
