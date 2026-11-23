# Connection runtime

Web, desktop, and mobile share one connection owner per environment in `packages/client-runtime`.
Platform code supplies storage, credentials, network signals, and lifecycle events; React views
consume the runtime. Keeping retry and session ownership here prevents competing reconnect loops.

## One transport retry owner

- The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) is the sole owner of
  transport retries. Endpoint resolution and opening an RPC session are single attempts. Transient
  failures use jittered, capped exponential backoff that resets only after a connection stays up;
  offline and auth failures wait for an explicit wakeup.
- Foregrounding, network changes, explicit retries, and offline reports probe the established
  session rather than tearing it down (OS offline reports are often wrong, especially for
  loopback). When the host answers a fresh request while the socket stays silent, on non-loopback
  network changes, or when a better route appears, a replacement connects beside the live session
  and takes over in place without showing a reconnect; a non-upgrade replacement closes if the live
  socket proves alive, and a worse-route replacement waits as fallback.
- The [registry](../../packages/client-runtime/src/connection/registry.ts) scopes connections by
  environment. An involuntary disconnect keeps the registration and cached projections; explicit
  removal closes the scope and clears credentials, caches, and drafts. Cloud-account changes apply
  only to relay registrations and must never discard directly paired environments.

## HTTP authorization vs. socket lifetime

RPC sockets authenticate at upgrade, while HTTP requests pull current credentials from the
[authorization service](../../packages/client-runtime/src/authorization/service.ts). Never tear down
a healthy socket because an HTTP refresh failed—renewal failure belongs to the HTTP operation. Live
sockets whose access token nears expiry renew in place on the same session so open conversations are
not interrupted. Session listings retain unrevoked connected sessions after credential expiry so
active connections stay manageable without extending the credential's lifetime.

## Transport health and data freshness are separate

- An open socket does not mean the environment is usable. The RPC session waits for initial server
  configuration, and shell and thread subscriptions maintain their own sync state. Never label a
  failed subscription "reconnecting" when the transport is healthy.
- Cached projections stay readable offline, but must never imply a live connection or overwrite
  newer live data on reconnect.
- **Shell snapshots are intentionally partial.** Servers omit idle subagent children and older
  settled threads on demand; left-out rows load via thread-family, shelf, and search queries. A
  missing shell row therefore never proves a thread is deleted—code that deletes data or worktrees
  on absence must verify with the family or server first.

## Subscriptions, caching, and mutations

- [Thread detail](../../packages/client-runtime/src/state/threads.ts) separates subscription
  lifetime from cache lifetime: mounted consumers share one live stream (stopping when the last
  unmounts), while a short-lived cache retains state and its replay cursor for fast back navigation.
- Commit cached state and replay cursor together only after an update completes. Cancellation must
  not advance the cursor past applied data, and an old scope must not overwrite a newer scope's
  cache.
- Durable subscriptions follow replacement sessions automatically. Reconnection never auto-replays
  mutations—retry and idempotency belong to each operation.
