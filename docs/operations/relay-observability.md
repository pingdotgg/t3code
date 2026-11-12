# Relay observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

The relay Alchemy stack owns a shared Axiom trace setup:

- `t3-code-relay-traces-prod`, the OpenTelemetry trace dataset shared by the Worker, mobile app, and
  first-party relay clients
- `t3-code-relay-otel-ingest-prod`, the dataset-scoped Worker ingest token
- `t3-code-mobile-otel-ingest-prod`, the dataset-scoped mobile ingest token
- `t3-code-relay-client-otel-ingest-prod`, the dataset-scoped first-party relay-client ingest token
- `t3-code-relay-recent-spans-prod`, a view of recent request and endpoint spans
- `t3-code-mobile-logs-prod` and `t3-code-mobile-metrics-prod`, the mobile app's crash, error, and
  startup data from `expo-observe` (see [Mobile crashes and errors](#mobile-crashes-and-errors))
- `t3-code-mobile-telemetry-ingest-prod`, the ingest token the Worker forwards that data with
- `t3-code-mobile-sourcemaps-prod`, the R2 bucket of mobile JavaScript source maps, and
  `t3-code-mobile-sourcemaps-upload-prod`, a Cloudflare token that can only write objects to it

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
account limit, which Cloudflare raised to 20,000 calls per 5 minutes in October 2026 (peak use then
was about 2,100).

**Traffic dropped.** The Worker is down, a deploy broke it, or spans stopped reaching Axiom. Check
`https://relay.t3.codes/health` first.

**Tunnel cleanup stopped / tunnel deletions failing.** Warnings for the five-minute reaper that deletes
idle Cloudflare tunnels. "Stopped" counts sweeps that finished, so it also fires when every sweep
fails; a sweep fails when listing tunnels does, usually behind Cloudflare 429s. Idle tunnels are
billed until the reaper catches up, which the "Idle tunnels in Cloudflare" chart shows. A failed
sweep records no counts, so while sweeps fail the chart stops at the last good one; check the tunnel
list in the Cloudflare dashboard for current numbers. For failed
deletions, read the relay's "Failed to delete an inactive managed tunnel" warnings. To pause cleanup,
see [Managed tunnel cleanup rollout](release.md#managed-tunnel-cleanup-rollout).

**Links degraded / database slow.** Warnings for slow degradation. Link failures above 20% over six
hours have so far meant provisioning running into the 9 s deadline, with Postgres latency as the
usual cause.

## Mobile crashes and errors

The mobile app reports through [`expo-observe`](https://docs.expo.dev/eas/observe/). Its
`endpointUrl` points at the relay (`/v1/mobile/observe`, set in `apps/mobile/app.config.ts` from
`T3CODE_RELAY_URL`), because Observe cannot send auth headers and prefixes every path with the EAS
project id. The relay forwards each request to Axiom with its own token: logs (JavaScript errors,
native crashes, log events) to `t3-code-mobile-logs-*`, metrics to `t3-code-mobile-metrics-*`, and
spans to the shared traces dataset. Expo's Observe dashboard receives nothing. The endpoint URL is
compiled into the native app, so pointing it elsewhere takes a store build.

Hermes stacks from release builds are minified bytecode offsets. On the way through, the relay
rewrites each JavaScript exception's `exception.stacktrace` with the bundle's source map from R2
and records the outcome on the log record:

- `relay.symbolication.status`: `symbolicated`, or why not. `no_bundle_id` is a development or
  local build. `source_map_missing` means no map was uploaded for the bundle;
  `source_map_too_large`, `source_map_invalid` and `source_map_unavailable` (R2 unreadable, retried
  shortly) mean one was. `source_map_limit` is a request naming more bundles than the relay decodes
  at once, and `no_bundle_frames` a stack with no frames from the bundle.
- `relay.symbolication.source_map`: the R2 key used
- `relay.symbolication.raw_stacktrace`: the original stack, when it was rewritten

iOS frames lose their install path (`/private/var/containers/Bundle/Application/<uuid>/...`), which
differs per install, so `exception.stacktrace` groups across users.

A fatal JavaScript error ends in a native abort, which Observe reports as a second crash with a
generic React Native stack. The relay marks that one `relay.crash.js_fatal` when both arrive in one
request, as they do on the next launch. Leave it out to count real native crashes:

```apl
['t3-code-mobile-logs-prod']
| where ['attributes.expo.error.source'] == 'nativeCrash'
| where isnull(['attributes.relay.crash.js_fatal'])
| summarize count() by ['attributes.exception.type'], ['attributes.exception.message']
```

Native crash stacks (`expo.error.source == 'nativeCrash'`) are not symbolicated. On iOS, app frames
read like `main (T3Code + 19476)`: the offset into the app binary. The build hook uploads that
build's dSYMs to `ios/dsym/<easBuildId>.zip`; download it with an account R2 token, then:

```sh
unzip <easBuildId>.zip
atos -arch arm64 -o T3Code.app.dSYM/Contents/Resources/DWARF/T3Code -l 0x100000000 \
  $(printf '0x%x' $((0x100000000 + 19476)))
```

Maps are keyed by the bundle that crashed: `<platform>/ota/<updateId>.map` for OTA updates and
`<platform>/build/<easBuildId>.map` for the bundle embedded in a store build. The production
mobile workflow uploads OTA maps after `eas update`, and the `eas-build-on-success` hook in
`apps/mobile/package.json` uploads a build's map, both with `apps/mobile/scripts/upload-sourcemaps.mts`.
They need the `MOBILE_SOURCEMAPS_R2` secret, a JSON value the stack outputs as
`mobileSourceMapsUploadCredentials` from a token that can only write to the bucket. Creating that
token needs **Account API Tokens: Edit** on the deploy token. Deploy output shows it redacted; read
it from state, where it is under `__redacted__`:

```sh
cd infra/relay && vp exec alchemy state read T3CodeRelay/prod/output
```

Set it as a GitHub Actions secret, for OTA updates, and as an EAS environment variable with
`secret` visibility in the `production` environment only, for builds. Keep it out of `preview`:
PR preview builds run the PR's code in that environment. In CI only the upload step gets it, not
`eas update` and the dependencies it runs. If the deploy replaces the token, update both.

The `t3-code-mobile-health` dashboard is the place to look every few days: crash and handled
error counts, top crashes with the installs and app versions they hit, crashes by version, whether
stacks are symbolicated, and whether reports reach the relay at all. A crash counts once: the
native abort after a JS crash (`relay.crash.js_fatal`) is left out. Startup times are metrics, so
they are not on it; query `t3-code-mobile-metrics-*` with MPL. Prod and PR previews get the
dashboard, and deployments with `RELAY_ALERT_NOTIFIER_ID` get these monitors
([`infra/relay/src/mobileTelemetry/monitoring.ts`](../../infra/relay/src/mobileTelemetry/monitoring.ts)):

- **crash spike** (pages): crashes per 15 min well above the same time over the last 7 days. Until
  a week of data exists it has no baseline. A spike right after a release usually means a bad OTA
  update; roll it back in EAS.
- **one crash hitting many installs** (pages): a single crash on 25 installs within an hour.
- **reports stopped** (warning): no startup metrics forwarded for an hour, so crashes are not
  arriving either.
- **crash stacks not symbolicated** (warning): over half of release JS stacks stayed minified for
  6 h. `relay.symbolication.status` names the cause.

Thresholds are starting points, not measured baselines; revisit them after two weeks of
production data.

Without it, uploads are skipped with a warning and stacks stay minified. Each ingest request is one
`relay.mobile_telemetry.ingest` span; `relay.mobile_telemetry.outcome` is `forwarded`,
`rate_limited`, `body_too_large`, `upstream_unavailable`, or `upstream_timeout`.
