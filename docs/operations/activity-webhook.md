# Activity webhook

> For maintainers running a T3 server on a remote host. Using T3 Code? See [docs/user](../user/).

Hosting platforms suspend idle machines. When the T3 server runs on such a host, it can POST a
heartbeat to a webhook while agent work is in progress so the platform keeps the machine awake even
after every client has disconnected. T3 knows nothing about the platform: it only sends a small
JSON body to a URL with a bearer token, and the platform decides what to do with it.

The feature is off unless `T3CODE_ACTIVITY_WEBHOOK_URL` is set. Implementation:
`apps/server/src/activityWebhook/ActivityWebhook.ts`.

## Env vars

| Variable                              | Required | Default | Meaning                                                                                                         |
| ------------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `T3CODE_ACTIVITY_WEBHOOK_URL`         | no       | unset   | `http(s)` URL to POST to. Unset disables the feature.                                                           |
| `T3CODE_ACTIVITY_WEBHOOK_TOKEN`       | with URL | unset   | Sent as `Authorization: Bearer <token>`. URL without token logs one warning and disables the feature.           |
| `T3CODE_ACTIVITY_WEBHOOK_INTERVAL_MS` | no       | `60000` | Heartbeat interval. Accepts `5000` to `3600000`; anything else logs a warning and uses the default.             |
| `T3CODE_ACTIVITY_WEBHOOK_CONFIG_FILE` | no       | unset   | Optional `KEY=VALUE` file holding any of the variables above. The process environment wins on conflicting keys. |

Invalid or incomplete configuration never fails server startup; the server logs one warning and runs
without heartbeats.

A `Host` header override is not supported: the server sends requests through `fetch`, which drops a
`Host` header instead of forwarding it. An endpoint that validates the header must accept the
hostname the server connects to, so point the URL at that hostname.

## Request

```http
POST <T3CODE_ACTIVITY_WEBHOOK_URL>
Authorization: Bearer <token>
Content-Type: application/json

{ "source": "t3code", "activeThreads": 2, "sentAt": "2026-09-18T12:00:00.000Z" }
```

Any `2xx` response counts as success. The body is informational; a platform may ignore it and treat
every request as "extend the lease".

## When heartbeats are sent

A thread is _active_ while its session status is `starting` or `running` and it has no open
approval or user-input request. A thread that is `ready`, `idle`, `stopped`, `interrupted`, in
`error`, or waiting on the user is not active, so an agent blocked on a permission prompt does not
keep a machine awake. The state is derived from the orchestration event stream (`thread.session-set`,
`thread.activity-appended`, `thread.deleted`), not from client connections or provider processes.

- The first active thread triggers an immediate POST, then one every interval.
- Additional active threads share the same loop; `activeThreads` reflects the count.
- The loop stops as soon as the last active thread leaves. No final "release" request is sent; the
  platform's own idle timeout takes over.
- Server shutdown interrupts the loop.

## Failure handling

Each attempt is bounded by a 10 second timeout, so an endpoint that accepts a connection and never
answers cannot stall the tick. A failed heartbeat (timeout, network error, or non-`2xx`) is retried
up to three attempts per tick with 1s and 2s backoff, then abandoned until the next interval. The warning log carries only the URL host,
the HTTP status, and the failure kind.

## Security

- The token is never logged, and neither is the request or the `Authorization` header.
- Prefer `T3CODE_ACTIVITY_WEBHOOK_CONFIG_FILE` pointing at a file readable only by the server's
  user over exporting the token in a shell profile, where it leaks into every child process.
- The webhook only ever learns that work is happening and how many threads are active.
