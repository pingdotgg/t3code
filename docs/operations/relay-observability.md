# Relay observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

The relay Alchemy stack owns a shared Axiom trace setup:

- `t3-code-relay-traces-prod`, the OpenTelemetry trace dataset shared by the Worker, mobile app, and
  first-party relay clients
- `t3-code-relay-otel-ingest-prod`, the dataset-scoped Worker ingest token
- `t3-code-mobile-otel-ingest-prod`, the dataset-scoped mobile ingest token
- `t3-code-relay-client-otel-ingest-prod`, the dataset-scoped first-party relay-client ingest token
- `t3-code-relay-recent-spans-prod`, a view of recent request and endpoint spans

Alchemy stages append their sanitized stage name to isolate resources, for example
`t3-code-relay-traces-dev-julius` for a personal stage.

Deploy from `infra/relay` with the normal Alchemy workflow:

```sh
vp run deploy
```

Alchemy resolves account-level Axiom deployment credentials through its provider. At runtime, the
Worker receives only its scoped ingest token. Mobile and relay clients use their own separately
provisioned scoped ingest tokens.

The Worker emits Effect's built-in HTTP server spans plus endpoint and database child spans.
Effect's OpenTelemetry exporter stores semantic HTTP attributes below the `attributes.` prefix.
For example:

```apl
['t3-code-relay-traces-prod']
| where kind == 'server'
| extend endpoint = column_ifexists('attributes.http.route', ''),
    customAttributes = column_ifexists('attributes.custom', dynamic({}))
| project _time, name, trace_id, duration,
    ['attributes.http.request.method'],
    ['attributes.url.path'],
    ['attributes.http.response.status_code'],
    endpoint,
    relayOperation = customAttributes['relay']['operation']
| order by _time desc
| limit 200
```

The provisioned view also reads the endpoint from `attributes.http.route`. Relay-specific span
annotations are stored under `attributes.custom`; `relay.operation` is one of the emitted custom
attributes.

Agents should prefer the provisioned view or APL queries for completed incidents instead of
tailing the Cloudflare Worker. The stack does not provision a separate query token. Responders who
need scripted query access use the authorized account-level `AXIOM_TOKEN` together with
`AXIOM_ORG_ID`; scoped ingest tokens remain write-only credentials for their producers.

DPoP proof failures include the stable `relay.dpop.failure_code` span attribute. A `time_window`
failure means that a signed proof was too old or too far in the future for the relay's allowed
window. It can point to a date or time problem on either device, but it can also result from a
delayed request. The client uses this category, and the absence of a category from an older relay,
to decide whether clock skew is confirmed or only one possible cause.

## Webhooks

A public webhook request is one `relay.hooks.forward` span. Its `relay.hook.outcome` says what
happened: `forwarded`, `held`, `rate_limited`, `inbox_full`, `not_found`, `payload_too_large`,
`environment_unavailable`, or `environment_timeout`. `relay.hook.endpoint_key` identifies the
managed endpoint, and with it the environment. On a forward, `relay.hook.upstream_status` or
`relay.hook.upstream_error` records the environment's answer, and
`relay.hook.upstream_outcome` what it did with the request (`accepted`, `duplicate`,
`prompt_too_long`, `queue_full`, `rejected_signature`, `expired`, `disabled`, ...), from its
`x-t3-hook-outcome` response header. A held request's delivery records the same on its
`relay.inbox.deliver` span. The relay sends its own `traceparent` with each forward and drops any a
sender supplied, and signs each forward (`x-t3-relay-delivery`) so the environment trusts the
relay's delivery id, receive time and trace context only from the relay, so on environments that export to T3 Connect, the environment's
`ScheduledTaskService.triggerWebhook` span lands in the same trace. `relay.hook.rate_limit` says which
budget ran out: `endpoint` or `hook`. `relay.hook.rate_limiter_failed_open` is set when the
Cloudflare rate limiter was unavailable and the request went through unlimited.

Held requests are handled in the endpoint's `HookInboxObject`, and each call into it is its own
trace, not a child of the forward span: `relay.inbox.hold`, `relay.inbox.wake`, and
`relay.inbox.deliver` for each alarm run. Each carries `relay.hook.endpoint_key`, so they join to
forwards. The details are on the child spans: `HookInboxStore.hold` carries
`relay.inbox.refused` when the inbox refused a request (`max_per_hook`, `max_requests`,
`max_bytes`, or `already_held`). `HookInboxStore.deliverDue` carries `relay.inbox.run_result`
(`drained`, `more_pending`, `busy`, or `unreachable`), how many requests it sent and delivered,
the consecutive failures behind the retry delay, the longest time a delivered request waited, and
the backlog left. A run that errored outright has `relay.inbox.run_result = failed` on the root
`relay.inbox.deliver` span instead.

Questions these answer:

```apl
// Webhook outcomes per hour
['t3-code-relay-traces-prod']
| where name == 'relay.hooks.forward'
| summarize count() by bin(_time, 1h), outcome = tostring(['attributes.custom']['relay.hook.outcome'])

// Inboxes stuck behind an unreachable environment, by endpoint
['t3-code-relay-traces-prod']
| where name == 'HookInboxStore.deliverDue'
| extend c = ['attributes.custom']
| where tostring(c['relay.inbox.run_result']) == 'unreachable'
| project trace_id, failures = toint(c['relay.inbox.consecutive_failures']),
    backlog = toint(c['relay.inbox.held_count'])
| join kind=inner (
    ['t3-code-relay-traces-prod']
    | where name == 'relay.inbox.deliver'
    | project trace_id, endpoint = tostring(['attributes.custom']['relay.hook.endpoint_key'])
  ) on trace_id
| summarize runs = count(), failures = max(failures), backlog = max(backlog) by endpoint
```

## Alerts

The stack provisions threshold monitors and a `t3-code-relay-health` dashboard from
[`infra/relay/src/monitoring.ts`](../../infra/relay/src/monitoring.ts) when the deployment sets
`RELAY_ALERT_NOTIFIER_ID`. Paging monitors go to that notifier and need two failing runs in a row.
Warnings go to `RELAY_WARNING_NOTIFIER_ID` when it is set and are otherwise only visible in Axiom.
Each monitor's description gives its healthy baseline.

Monitors count HTTP status codes, not span errors. A request the relay cuts off at its 9 s deadline
ends as an interrupted span without an error flag, but still answers 504. `/connect` 502s are
normal: offline hosts produce most of them, retried by their clients every few seconds.

The dashboard's "Connecting" charts show connections as users see them. Web, desktop, and mobile
export a root `relay.connection.attempt` span per attempt, which lasts until initial sync finishes, in
the same trace as the relay's and the host's spans. Most reconnects reuse a cached relay token and go
straight to the host, so relay latency only affects cold connects. A slow total with fast phases
usually means the client waited out an unreachable direct (LAN) route before falling back to the relay.

**Links failing / tunnel recovery failing.** Open the dashboard's "Link failures by reason" table.
`provisioning: ensure-tunnel` or `configure-tunnel` with Cloudflare 429s on the "Cloudflare API calls
by status" chart is the #16810 failure: the account's Cloudflare API rate limit. Ask Cloudflare to
raise it, and check whether something is calling the API in a loop (tunnel recovery from hosts is the
largest caller). Slow Postgres instead points at the database or Hyperdrive.

**Environments unreachable.** Clients reach fewer hosts than usual. Check Cloudflare Tunnel status and
recent relay deploys before suspecting hosts: a host-side problem does not move this many
environments at once.

**Push delivery failing.** Look at the `relay.apns_deliveries.process_signed_job` or `relay.fcm.process`
error messages. An expired APNs key or FCM service account fails every job.

**Cloudflare API rate limited / near its limit.** The warning fires on sustained 429s; the page fires
when they are frequent enough to stall provisioning. Compare the call volume on the dashboard with the
account limit.

**Traffic dropped.** The Worker is down, a deploy broke it, or spans stopped reaching Axiom. Check
`https://relay.t3.codes/health` first.

**Links degraded / database slow.** Warnings for slow degradation. Link failures above 20% over six
hours have so far meant provisioning running into the 9 s deadline, with Postgres latency as the
usual cause.
