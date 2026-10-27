# Connection runtime

Web, the desktop renderer, and mobile share one connection owner per environment
in `packages/client-runtime`. Platform code supplies storage, credentials, network
signals, and application lifecycle events. React views consume the runtime.
Keeping retries and session lifetime here prevents competing reconnect loops when
several views need the same environment.

## One transport retry owner

The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) owns
transport retry policy; resolving an endpoint and opening an RPC session are single
attempts. Transient failures retry with jittered exponential backoff, capped at
five minutes, that resets only after a connection stays up. Without jitter, every
client of a restarted server reconnects in the same second; with a short cap, a
client that can never connect retries all day. Offline states and authentication
failures wait for a wakeup instead of spending attempts on unchanged conditions.

Foregrounding, a network change, an explicit retry, and an offline report probe
the established session, and only a failed probe reconnects. Offline reports are
often wrong, for example for a loopback server. The OS can kill a suspended
socket without a close event, so a probe still unanswered after 500 ms asks the
host for its public descriptor over a fresh request, again each second until it
answers. If the host answers while the socket delivers no frame, the socket is
dead and is replaced, even while the network reports offline: at once on
loopback and LAN, and 2.5 seconds after the check starts elsewhere, where one
lost packet can stall a live socket. Without that evidence the probe deadline
decides: 3 seconds on loopback and LAN routes and after a long mobile
suspension, when the data on screen is stale; 15 seconds elsewhere, because a
tailnet over DERP or a VPN can be slower than that on a live socket. A long
suspension's probe that times out also replaces the socket regardless of the
network report. The web and desktop foreground probe skips the fresh request,
because a busy host can answer it before a queued probe. Foregrounding also
wakes a pending retry immediately. A long suspension restarts an in-flight
attempt; a short one leaves it alone.

The [registry](../../packages/client-runtime/src/connection/registry.ts) scopes
connections by environment. An involuntary disconnect retains the registration
and cached data. Explicit removal closes the scope and clears credentials,
projections, and platform-owned state such as drafts. Cloud-account changes apply
to relay registrations; they must not discard directly paired environments.

## HTTP authorization

RPC sessions authenticate at socket upgrade, while HTTP requests need current
credentials from the
[authorization service](../../packages/client-runtime/src/authorization/service.ts).
Replacing a healthy socket for HTTP renewal would interrupt conversations and
change the transport generation without a transport failure. Credential expiry
does not close the socket, and refresh failure belongs to the HTTP operation.

Session listings must retain unrevoked connected sessions after credential expiry
so an open connection does not disappear from connection management. This does
not extend the credential's lifetime. New HTTP requests and socket upgrades still
require valid credentials.

## Transport health and data freshness are separate

A socket opening is insufficient evidence that the environment is usable. The
[RPC session](../../packages/client-runtime/src/rpc/session.ts) waits for the
initial server configuration before becoming ready. Shell and thread data then
have their own synchronization state. A failed shell subscription can coexist
with a healthy connection; labeling that state "reconnecting" promises a
transport retry that will never happen.

Cached projections remain readable offline. They must neither imply a live
connection nor overwrite newer live data during a reconnect. Loading and
resuming snapshots belongs to the shared state services, so every view agrees
on which data is current.

Shell snapshots can leave rows out when the client asks. Servers that advertise
`shellThreadFamilies` leave out idle subagent children: a child stays while it
has a live or queued run, a pending request or background work, or a subagent
child of its own, so badge and working walks never meet a gap. Servers that also
advertise `shellOlderSettled` keep only the 25 newest settled top-level threads
(and any tied with the 25th, pinned, snoozed, live, or above a kept child); the
snapshot's `olderSettled` names that cut and counts the rest per project. Left-out
rows load on demand and merge behind shell rows
([thread families](../../packages/client-runtime/src/state/threadFamilies.ts)):
the family a thread view or a queued message mounts holds every active thread
sharing the thread's root, so it also brings back an old settled thread opened by
link; the Settled shelf reads pages below the cut; searches return the rows of
older matches. A missing shell row therefore does not prove a thread is gone:
code that deletes data or a worktree on absence must check the family or the
server first.

The Settled count is local Settled rows, minus local rows below the cut, plus the
server's counts
([older settled threads](../../packages/client-runtime/src/state/olderSettledThreads.ts)).
The counts are re-read when a removal or an old row's arrival or change could
move them, so archiving any thread costs one small read. A shelf lists an older
row only above the highest page frontier of the environments that can still
load, so the merged list stays a correct prefix while a page loads. An
environment with no snapshot this session, or a failed page, holds no one back.
On-demand reads wait for the session's first authoritative snapshot
(`generation > 0`), and each is keyed by generation. A resume that skips that
snapshot must still bump `generation` once verified, and may reuse a cached
snapshot only when its omissions match what the session asks for.

[Thread detail](../../packages/client-runtime/src/state/threads.ts) separates
subscription lifetime from cache lifetime. Mounted consumers share one live
stream, which stops when the last consumer unmounts; hidden mounted routes still
count. A registry-local cache retains state and its replay cursor for five idle
minutes so back navigation can resume without another snapshot download.

The desktop app adds one consumer: a
[keep-alive](../../apps/web/src/state/threads.ts) mounts every thread whose
session is starting or running, in each enabled environment. Opening a running
thread then needs no replay. The shell and detail streams are independent, so
the shell can report a stop before the detail loads or catches up. A stopped
thread stays mounted until its own stream is live and shows the stop, and the
stream then closes and saves the settled state.
Web and mobile do not keep threads alive.

Retain state and cursor together only after an update finishes. Cancellation must
not advance the cached cursor beyond the applied data, and an old scope must not
overwrite its successor's cache. Preserve pagination data on reuse, but clear
canceled loading state.

The [RPC boundary](../../packages/client-runtime/src/rpc/client.ts) resolves
requests against the current session at execution time. Durable subscriptions
follow replacement sessions. After a transport failure they wait for the
supervisor; an expected domain failure may resubscribe on the same healthy
session. Reconnection does not automatically replay mutations, whose retry and
idempotency rules belong to the operation.
