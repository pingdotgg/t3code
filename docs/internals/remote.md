# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, and SSH change how the client reaches that server; they do not
introduce another execution model. See
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
connect, including one that refuses this client's credential, moves on to
the next; only an incompatible server stops the walk, because it is the same
server on every route. While connected over a later route the
[supervisor](../../packages/client-runtime/src/connection/supervisor.ts)
preflights earlier routes of a better kind (loopback, LAN, tailnet or VPN,
public, SSH, best first) and replaces the session when one would
connect. An earlier route of the same kind is not worth a reconnect: MagicDNS
through `tailscale serve` and the raw tailnet address reach the same host, and
mobile reconnects over whichever answers first after every resume, so following
list order would replace the socket on nearly every foreground.
Preflight includes authorization so a route that answers but rejects this
client never costs a working session; a route that still fails afterwards is
held back for a cooldown so a flaky network cannot bounce the connection.

A connected server reports the LAN and tailnet addresses it is bound to, and the
client saves them as learned routes. A learned route reuses the credential of
the route it was learned over. A DPoP-bound token is not bound to an origin,
because each proof names the URL it signs. A paired bearer token only learns a plain HTTP address off the tailnet
when it was itself paired over plain HTTP, so a token paired over HTTPS never
starts travelling unencrypted. Learned routes the server stops reporting are
dropped, which is how a changed LAN address replaces the old one; routes the
user saved are never touched. The reported addresses are hints like any advertised endpoint, so a
learned route still has to answer as this environment before it is used.

A background service with no configured host is what makes this work for
headless machines. It listens on every IPv4 interface and closes each
connection unless both addresses of the direct peer are loopback, private, or
tailnet IPv4. That keeps a VPS's public address closed, including a cloud VM
whose public address is NATed to a private interface. It is not a firewall:
Tailscale Serve reaches the server over loopback by design, and a
proxy that rewrites the source address looks private. One listener per address would
miss a DHCP change, and the wildcard keeps the reported addresses current.

Pull request routing trust covers the whole route list. Adding or changing a route
revokes it; reordering does not, because the same addresses remain trusted.

## Peer links

A [peer link](../../apps/server/src/peer/PeerLinks.ts) lets one environment's
agents work in another. The linking environment signs in to the other's `/mcp`
as an outside MCP client, with a pairing code from it, and keeps that session's
token in its own secret store. The other environment needs nothing new: it
sees one more OAuth client, lists it in Environments, and revokes it there.
Unlinking on the linking side only forgets the token.

- **The device network switch (`linkedEnvironmentsEnabled`) gates both
  sides.** Off on the linking side, `PeerLinks.link`, link requests and
  `PeerForwarding.call`/`links` refuse; `readThread`, `waitForThread` and
  `interruptThread` do not, so a remote task already running still completes
  and can still be cancelled. Off on the receiving side, link registrations are
  refused and link sessions get a 403, which the linking side reports as
  retryable so the task's follower waits rather than failing it.
- **A tool runs in a linked environment when its parameters take
  `OrchestratorMcpEnvironmentTarget`** as `environmentId`.
  [`McpToolAccess.toLayer`](../../apps/server/src/mcp/McpToolAccess.ts) sends
  such a call there once the tool's access declaration has checked the caller,
  so a read-only or ended caller is refused before anything is sent. The
  thread or project the call names is checked where it lives. A tool that acts
  as the calling thread itself cannot take a linked environment.
- **Every forwarded call carries the calling agent's modes** in
  `T3-Mode-Limit`, which the receiving `/mcp` only ever narrows the client's
  approved access with. A plan-mode agent therefore cannot start full-access
  work through a full-access link.
- **The token goes only to an address that proves it is the linked
  environment**: its descriptor must report the linked environment id. A LAN
  address that now belongs to another machine never receives it.
- **All callers on one side share the link's single session on the other**,
  so idempotency keys are hashed with the caller's namespace before they
  leave. Without that, two agents reusing a key would collide on the far side.
- **A forwarded wait is split into calls of at most 50 s**, because the
  receiving `/mcp` sends nothing while a wait is open, and a proxy on the
  route may drop an idle request.

### Tailnet devices

[`TailnetDevices`](../../apps/server/src/peer/TailnetDevices.ts) makes the same
kind of link without a pairing code, but only between members of the user's
device network. **Same Tailscale account is never permission.** A machine joins
only when a full-access member adds it. It refuses to join while linked
environments is off, on a dev server, when it belongs to another network, or
when it revoked the machine adding it. Requests arriving through Serve come
from loopback with headers any local process can forge, so nothing inbound is
trusted:

- **The side giving access dials the other.** The issuer resolves the
  requester's address itself (a tailnet IP, or an https MagicDNS name, whose
  certificate only that node holds; plain http on a name is never used),
  whoises it, and checks its descriptor and its stable node id against the
  roster. It then asks that address to confirm the requester's pending
  challenge before minting anything, and delivers the token there. A forged
  request naming a real device's address dies at the confirmation, so no token
  is ever created for it.
- **Each direction is its own handshake.** The issuer links back before
  answering, so one request yields a mutual link, each half proven by the side
  granting it. Gossip between linked members only adds addresses to try.
- **A member is bound to its Tailscale node** (`StableID` from whois, `ID` in
  status). Only an explicit add binds or rebinds it, and a different node
  answering for the same environment id is refused. A member with no binding,
  as after an upgrade, is refused until the user adds it again; an inbound or
  first answer never binds one.
- **A machine in no network joins only while its owner allows it** there
  (`allowJoin`, ten minutes, in memory), and so do rebinding an unbound admin
  and a link to that machine alone (`local`), which may replace a code-paired
  link.

The [roster](../../apps/server/src/peer/Membership.ts) of members and network
apps is replicated and merged last-writer-wins by hybrid logical clock.
`revoked` is a tombstone that never expires, and outranks any write that does
not name it in `restores`, so a machine that missed a revocation cannot undo it
by writing later; only a user's restore made after seeing it does. **A roster write counts only from
a member session (the signed `mbr` claim the handshake mints, never a
pairing-code link) whose machine is full access on the receiving side, and
never for an entry naming the sender**, so a revoked or limited machine cannot
widen itself, even relayed through another. Each machine also keeps local
limits that never replicate. Effective access is the narrower of the roster
and the local limit. Each `/mcp` request narrows a member session's token to
that, so a change applies without re-linking. Widening past what the token was
minted with takes a new handshake. Narrowing or revoking a member also ends the
sessions it brokered for apps, which were minted for more. Agents may only
narrow, and never change the machine their link comes from: widening and
restoring are the user's. A machine with the switch off still takes revocations
and narrowing from a member's sync, never widening, and mints nothing.

A machine that leaves writes its own tombstone (stamped by itself) and clears
its roster, so a restore would list a machine that takes no part: it is
refused, and the user adds the machine again, a join whose write names the
tombstone in `restores`. Leaving ends every app and member session except the
one that asked, which keeps its scopes, so a machine reached only through the
network can still allow joining and be added again. It is never renewed without
the network, so it lasts until its own expiry. On rejoining, app sessions whose
app is not live in the adopted roster end, the kept one included. A revocation is never
restamped, so its stamp still says who wrote it. Forgetting hides a tombstone on
one machine only; found on the tailnet again, the machine is offered to add like
any other.

Every member write, and every link to one machine only, also writes the level an
older build reads (`tailnet_device_policy`, narrowed by the local limit; a
forgotten link writes `revoked`), because that build lets a machine with no row
there in at full access. Nothing reads it back.

An app opens another member through the server it is connected to, which asks
that member over its member session for a one-time pairing credential. The
credential is capped at the app's own grant. For an app of the network
(session subject `network-app:<id>`), it is also capped at that app's roster
access, not the access of the machine relaying for it. Narrowing or revoking a
network app ends its sessions on every member, because sessions cannot be
re-scoped in place, so it pairs again; an invitation naming `replacesAppId`
revokes and hides the old app when it is redeemed, in the same roster write. App sessions carry no agent mode
ceiling, so anything below full access opens read-only. One table in contracts,
`NETWORK_ACCESS_CEILING`, sets this and also caps member MCP sessions and agent
calls relayed through a connected app (`McpGatewayBroker`). A relayed call is
capped on every call by this machine's own roster access. A member is relayed
only by this machine's own desktop app (its `desktop-bootstrap` session) or a
network app's session, within that app's access; a code-paired session cannot
take a member's traffic. Each call goes to an app whose own grant covers it:
those apps first, then code-paired sessions by connect time, with an app that last
failed to carry a call to that environment last. A code-paired session therefore
runs a non-member's call whenever no desktop or network app covers it, or one that
does could not run it. A call moves to the next app only when it cannot have run
(never taken, or the app answered that it cannot reach or was not granted the
environment) or is a read left unanswered; a write that may have run is never sent
twice, and an app's ordinary error goes back to the agent. A call may wait its own
declared maximum, such as a task watch, plus a fixed answer window.
Each relayed call also carries the calling chat's modes, and the app answering
it applies them against its own reads of the target, so a relaying server that
was told a wrong thread mode cannot widen the call; a call with no modes runs as
the narrowest chat. The app also caps each call by the target's own roster
access for the calling machine, so a caller with a stale roster cannot act past
a revoke it has not seen. Only a full-access chat may change the agent library:
every client syncs it to every machine at no ceiling, so a per-call check could
not stop a limited chat's edit reaching a broader agent. A phone needs one
reachable member to renew, and if every full-access member is lost, the
network has to be started again from a fresh machine.

**Work a link paired below full access starts stays within that link.** The
receiving environment knows a session is a peer link because the linking side
registers its OAuth client with the `t3code-peer-link` software id, and the
marker is signed into the session. Threads that session launches carry it, with
the access it was paired with, as an immutable `linkOrigin`, and so do the
subagents, forks and `create_threads` they derive. The rules live in
[`mcp/linkOrigin.ts`](../../apps/server/src/mcp/linkOrigin.ts) and run in the
shared access declarations, not tool by tool:

- linked work may change only threads with the same origin, not the user's own
  threads and not another link's;
- it cannot change projects, settings or scheduled tasks, nor use the receiving
  environment's own links;
- its project setup scripts are skipped
  ([`ProjectSetupScriptRunner`](../../apps/server/src/project/ProjectSetupScriptRunner.ts)
  checks every path that runs them).

Reads are not fenced, and a client's own `thread.create` can never carry
`linkOrigin`.

**A delegated task can run in a linked environment.** Its child is then an
ordinary thread there, so the parent here records the task without a child
thread of its own (`remoteChild` instead of `childThreadId`). A follower in
[`RemoteDelegation`](../../apps/server/src/peer/RemoteDelegation.ts) waits on
that thread and completes the task with `delegated_task.remote.complete`. That
internal command reuses the parent half of a local finalize, so the parent
wakes the same way. Open remote tasks are followed again at startup, which is
also what keeps restart recovery from treating them as abandoned provider work.

The link is routing, not isolation: an agent the link starts runs as the
receiving environment's user. **A full-access link is therefore not fenced**:
its agents can already do anything that user can, so the fence would only stop
T3's own tools. Its work still carries `linkOrigin`, so clients show where it
came from. A stamp without the access, from before it was recorded, is fenced.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context; the hosted app reaches a backend
only at an HTTPS address that browser can open, such as a tailnet address served
by Tailscale Serve.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md).

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
auth and platform-managed discovery are skipped and only saved environments (pairing, SSH)
connect. This is possible because the desktop renderer is not served by the backend: the `t3code://`
scheme serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.
