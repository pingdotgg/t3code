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
- **A descriptor's environment id filters addresses; it does not prove
  identity.** The token goes only to an address that reports the linked id, so
  a LAN address that now reports another machine's never receives it. Anything can
  report any id, though, so only addresses from the user's client count as a
  machine's, and never a loopback one, which names whichever machine opens
  it. An address an agent gives is recorded alone, and
  [`linkRequestTarget`](../../packages/client-runtime/src/linkRequest.ts) names
  a machine for it only when the client already reaches exactly one machine
  there. An address alone never moves an unexpired link to another address.
- **All callers on one side share the link's single session on the other**,
  so idempotency keys are hashed with the caller's namespace before they
  leave. Without that, two agents reusing a key would collide on the far side.
- **A forwarded wait is split into calls of at most 50 s**, because the
  receiving `/mcp` sends nothing while a wait is open, and a proxy on the
  route may drop an idle request.

### Tailnet devices

[`TailnetDevices`](../../apps/server/src/peer/TailnetDevices.ts) makes the same
kind of link without a pairing code, between the members of the user's device
network. **A user has one network.** Being one of the owner's Tailscale nodes
only gets a machine listed. It becomes a member when the owner allows it once,
from any full-access member, and that one act is the whole grant:

- **A machine on its own is asked nothing.** It joins whichever of the owner's
  nodes allowed it and takes that roster whole. This replaces the consent step
  that used to run on the joining machine, so a process on any of the owner's
  nodes can take in a machine that has no network yet.
- **A machine that has members takes a join only from one of them**, a
  full-access member answering from the node it is bound to, and then merges
  the roster by the ordinary sync rules. A node the network does not know
  cannot pull it anywhere or rewrite it: the owner allows that node from a
  member. Two machines that each built a network do not merge by themselves;
  one leaves its own first.
- A machine refuses to join while linked environments is off, on a dev server,
  or when it revoked the machine allowing it.

Requests arriving through Serve come from loopback with headers any local
process can forge, so nothing inbound is trusted:

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
- **Membership is the grant; a link is only how it is carried.** A member links
  to a machine the moment a sync adds it to the roster, and opening a member
  makes a link that is missing, expired or kept at an address that stopped
  answering. No user step, scan or pairing code stands between a roster entry
  and access both ways. The scan only repairs what those missed.
- **A member is bound to its Tailscale node** (`StableID` from whois, `ID` in
  status). Only the owner's Allow binds or rebinds it, and a different node answering
  for the same environment id is refused. A member left unbound by the upgrade
  rebinds only through this machine's own link to it (handshake-made or paired
  by code): proved at that link's stored addresses (a MagicDNS name is whichever
  owner node holds it now, as the link always trusted), with a live session this
  side issued, confirmed by challenge, at the roster's level. A code-paired
  session's self-chosen id gains nothing, because the challenge is confirmed at
  this machine's own stored address. Otherwise it is refused until the user
  allows it again; an inbound or first answer never binds one.
- **Machines linked both ways before the roster existed stay one network.**
  Migration 022 makes such a peer (a live link here and a live session it holds
  here) a member at the level that session grants, stamped at zero. Equal stamps
  go to the narrower level, so those seeds converge whichever machine updates
  first. A one-way link, a found machine or anything revoked here stays out.
- **Rosters that drifted apart converge without the user**, through the sync
  from a full-access member both sides list. Nothing automatic binds a node,
  restores a revoked machine or admits one: those are the owner's Allow.
- **A machine announces itself.** A scan tells each machine it finds that it is
  there (`hello`), and that machine lists it after proving the address through
  Tailscale. A machine that starts while its node was already online is
  therefore offered everywhere at once, not at the others' next ten-minute
  scan. Nothing is granted by a hello.
- **A handshake slot is held for the proof only.** Each side whoises and dials
  out under a small limit, because the caller is unauthenticated. The link back
  and the roster exchange wait on the other machine's own handshake, so they
  run outside it; holding a slot across them let several machines linking at
  once starve each other until a timeout.
- **A link or session minted while its machine was being revoked is cut.** The
  handshake checks the roster again after it stores or issues.

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
refused, and the user allows the machine again, a join whose write names the
tombstone in `restores`. Leaving ends every app and member session except the
one that asked, which keeps its scopes, so a machine reached only through the
network can still be allowed again from there. It is never renewed without
the network, so it lasts until its own expiry. On rejoining, app sessions whose
app is not live in the adopted roster end, the kept one included. A revocation is never
restamped, so its stamp still says who wrote it. Clients never list a tombstone:
a revoked machine found on the tailnet again is offered like any new one.

Every member write also writes the level an older build reads
(`tailnet_device_policy`, narrowed by the local limit), because that build lets
a machine with no row there in at full access. Nothing reads it back.

Apps open members without a click. A bounded loop, `dueNetworkMemberOpens` in
[`networkMembers.ts`](../../packages/client-runtime/src/connection/networkMembers.ts),
opens records not yet saved and re-opens refused sessions, including hand-paired
members still listed live. At most two opens run at once across all members,
with one attempt per change of opening hosts, online status or session
generation, and a 2 s to 5 min backoff. A failed open runs again after each
backoff while the member is still due: a machine is listed the instant it is
allowed, before the host asked can open it, so the first open often fails. The
client view ([`tailnetDevices.ts`](../../packages/client-runtime/src/tailnetDevices.ts))
is one network by construction: a machine any connected host lists live is a
member, whatever the other hosts' rosters hold so far. The app fetches the member's
public descriptor before asking any server to mint, so an offline member costs
no server-to-server call. A member switched off in this app (a record's `off`,
or a disabled saved entry) is never opened, which is why members offer that
switch and no Remove: a removed member would just be opened again. Desktop and code-paired sessions
that may write the network (`access:write`) get records for every listed member
too.

The server an app opens a member through asks that member over its member
session for a one-time pairing credential. The
credential is capped at the app's own grant. For an app of the network
(session subject `network-app:<id>`), it is also capped at that app's roster
access, not the access of the machine relaying for it. Narrowing or revoking a
network app ends its sessions on every member, because sessions cannot be
re-scoped in place, so it pairs again; an invitation naming `replacesAppId`
revokes and hides the old app when it is redeemed, in the same roster write. App sessions carry no agent mode
ceiling, so anything below full access opens read-only. One table in contracts,
`NETWORK_ACCESS_CEILING`, sets this and also caps member MCP sessions and agent
calls relayed through a connected app (`McpGatewayBroker`), or sent over this
server's own stored link when no app relays that environment. A relayed call is
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

## Desktop previews tunnel loopback

A desktop webview for another environment keeps `localhost` URLs and reaches the environment's
loopback through `/api/preview/tunnel`, one WebSocket per TCP connection, on the same origin as
every other request. That is why it works over any connection method. Four choices are easy to
undo by accident:

- **Fixed proxy, not PAC.** Chromium never consults a PAC script for loopback hosts, even with
  `<-loopback>`. The partition uses a fixed SOCKS5 proxy with the bypass list
  `*,<-loopback>,169.254.0.0/16,fe80::/10`, in that order, since the last matching rule wins:
  everything is direct except loopback. `<-loopback>` also takes link-local addresses, so the last
  two rules hand them back to the direct route. A fixed proxy also has no
  direct retry, so a failed tunnel is a connection error and never the reviewer's own localhost.
  The rule matches hostnames, not resolved addresses, so a custom name that resolves to loopback
  still goes direct.
- **Media tickets.** Desktop main opens the tunnel but holds no environment credentials. Media
  tickets are not DPoP-bound, so the renderer can hand one over. Main asks it for a tunnel URL per
  connection, which also makes the tunnel follow a route switch.
- **Owner check, not auth.** Chromium can't authenticate to a SOCKS proxy, so any local process
  can connect to the listener and ride this user's tunnel. On Linux the listener looks the client
  up in `/proc/net/tcp` and refuses other users. macOS and Windows have no such check yet. The
  mobile app's device preview has the same listener while it is open: iOS suspends other apps, but
  Android lets any app reach it, and apps cannot see another app's socket owner there.
- **System browser links** have no tunnel. They keep the private-network rewrite in
  [`browserTargetResolver.ts`](../../apps/web/src/browser/browserTargetResolver.ts).

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
