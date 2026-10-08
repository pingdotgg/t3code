# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment;
an agent reaches another environment's threads only through a peer link.
The canonical key follows the `upstream` remote when one exists, so pull request
features target the repository a fork tracks. A fork also reports its own
`origin`, and clients group and label by that, so a fork never collapses into a
checkout of its upstream.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

A saved environment holds an ordered list of routes, and the
[driver](../../packages/client-runtime/src/connection/driver.ts) connects over
the first that works. Each direct route is first checked with the public
descriptor, so a saved LAN address that a different machine answers on another
network receives no credential. That check is not proof of a working route:
when every route stays silent, each is still tried. A route that fails to
connect, including a blocked one such as a signed-out T3 Connect, moves on to
the next; only an incompatible server stops the walk, because it is the same
server on every route. While connected over a later route the
[supervisor](../../packages/client-runtime/src/connection/supervisor.ts)
preflights the earlier ones and replaces the session when one would connect.
Preflight includes authorization so a route that answers but rejects this
client never costs a working session; a route that still fails afterwards is
held back for a cooldown so a flaky network cannot bounce the connection.

A connected server reports the LAN and tailnet addresses it is bound to, and the
client saves them as learned routes. A learned route reuses the credential of
the route it was learned over: the T3 Connect access token, which is not bound
to an origin because each DPoP proof names the URL it signs, or the paired
bearer token. Learned routes the server stops reporting are dropped, which is
how a changed LAN address replaces the old one; routes the user saved are never
touched. The reported addresses are hints like any advertised endpoint, so a
learned route still has to answer as this environment before it is used.

GitHub routing trust covers the whole route list. Adding or changing a route
revokes it; reordering does not, because the same addresses remain trusted.

## Peer links

A [peer link](../../apps/server/src/peer/PeerLinks.ts) lets one environment's
agents work in another. The linking environment signs in to the other's `/mcp`
as an outside MCP client, with a pairing code from it, and keeps that session's
token in its own secret store. The other environment needs nothing new: it
sees one more OAuth client, lists it in Connections, and revokes it there.
Unlinking on the linking side only forgets the token.

- **Every forwarded call carries the calling agent's modes** in
  `T3-Mode-Limit`, which the receiving `/mcp` only ever narrows the client's
  approved access with. A plan-mode agent therefore cannot start full-access
  work through a full-access link. The tool's own access declaration also
  runs on the linking side first, so a read-only or ended caller is refused
  before anything is sent.
- **The token goes only to an address that proves it is the linked
  environment**: its descriptor must report the linked environment id. A LAN
  address that now belongs to another machine never receives it.
- **All callers on one side share the link's single session on the other**,
  so idempotency keys are hashed with the caller's namespace before they
  leave. Without that, two agents reusing a key would collide on the far side.
- **A forwarded wait is split into calls of at most 50 s**, because the
  receiving `/mcp` sends nothing while a wait is open and T3 Connect's edge
  drops idle requests after about 100 s.

**Work a link starts stays within that link.** The receiving environment knows a
session is a peer link because the linking side registers its OAuth client with
the `t3code-peer-link` software id, and the marker is signed into the session.
Threads that session launches carry it as an immutable `linkOrigin`, and so do
the subagents, forks and `create_threads` they derive. The rules live in
[`mcp/linkOrigin.ts`](../../apps/server/src/mcp/linkOrigin.ts) and run in the
shared access declarations, not tool by tool:

- linked work may change only threads with the same origin, not the user's own
  threads and not another link's;
- it cannot change projects, settings or scheduled tasks;
- its project setup scripts are skipped
  ([`ProjectSetupScriptRunner`](../../apps/server/src/project/ProjectSetupScriptRunner.ts)
  checks every path that runs them).

Reads are not fenced, and a client's own `thread.create` can never carry
`linkOrigin`.

The link is routing, not isolation: an agent the link starts runs as the
receiving environment's user, inside the limits above.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Desktop without a local environment

Desktop normally launches its own primary server, but the desktop setting `localEnvironmentEnabled`
(`apps/desktop/src/settings/DesktopAppSettings.ts`) turns that off. Changing it relaunches the app;
no local state is deleted. On the next start the main process skips port selection, server exposure,
and the primary and WSL backends, and opens the window right away. The renderer sees this through
`desktopBridge.getLocalEnvironmentEnabled()`: `readPrimaryEnvironmentTarget` returns null, so primary
auth and platform-managed discovery are skipped and only saved environments (pairing, relay, SSH)
connect. This is possible because the desktop renderer is not served by the backend: the `t3code://`
scheme serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.
