# Connection runtime

Web, the desktop renderer, and mobile share one connection owner per environment
in `packages/client-runtime`. Platform code supplies storage, credentials, network
signals, and application lifecycle events. React views consume the runtime.
Keeping retries and session lifetime here prevents competing reconnect loops when
several views need the same environment.

## One transport retry owner

The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) owns
transport retry policy; resolving an endpoint and opening an RPC session are single
attempts. Transient failures retry with capped backoff. Offline states and
authentication failures wait for a wakeup instead of spending attempts on
unchanged conditions.

Foregrounding needs different treatment depending on the connection's state.
It wakes a retry immediately, leaves an ordinary in-flight attempt alone, and
probes an established session before replacing it. A long mobile background
suspension forces replacement because the OS can kill a socket without reporting
closure. Treating every foreground event as a reconnect delays healthy attempts;
treating every resume as harmless leaves suspended sockets stuck.

A Wi-Fi/cellular handoff is the same problem without a foreground event: the
socket stays bound to the old interface while connectivity still reports online,
so [mobile](../../apps/mobile/src/connection/platform.ts) emits a
`network-path-changed` wakeup when the default interface type changes. A
connecting or connected supervisor replaces its lease; every other phase must
ignore it. The replacement also carries the retry ladder over, unlike a
foreground resume, which resets it. Both rules exist for the same reason: a
flapping interface is not user intent, and letting it shorten backoff would
hammer the server for no gain.

Replacement rather than a probe, because a probe cannot answer the question.
Android reports only the default network, so after a handoff the old interface
goes unobserved. During the handoff grace period it still answers, so the probe
passes; when it dies moments later nothing reports it, and recovery falls back
to the transport ping timeout. The interface change is itself the evidence that
the existing socket is doomed.

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

[Thread detail](../../packages/client-runtime/src/state/threads.ts) separates
subscription lifetime from cache lifetime. Mounted consumers share one live
stream, which stops when the last consumer unmounts; hidden mounted routes still
count. A registry-local cache retains state and its replay cursor for five idle
minutes so back navigation can resume without another snapshot download.

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
