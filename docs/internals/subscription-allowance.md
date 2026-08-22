# Subscription allowance

> For maintainers. Using T3 Code? See [docs/user/usage.md](../user/usage.md).

Subscription allowance is a current provider observation. It is deliberately separate from the
transcript-derived `UsageSummary` used by Historical. The allowance path is additive: it does not
change the historical contract, persist allowance history, or require a database migration.

## Boundaries

The public provider seam is [`ProviderAllowanceReader`][reader]. A materialized provider instance
may expose one reader with two responsibilities:

- `read` acquires one complete provider-native observation;
- `update` maps a provider runtime event to a sparse observation, when that provider supports live
  updates.

The reader does not expose subprocesses, SDK query objects, cache state, or orchestration state.
Those details stay in the provider adapter. The shared contract in [`usage.ts`][contract] preserves
provider-native windows, percentage meaning, reset timestamps, optional credits or spending
controls, freshness, provenance, and privacy-safe instance identity. Missing fields mean “not
reported”; they are never converted to zero.

## Server lifecycle

[`SubscriptionAllowanceService`][service] owns the environment-local lifecycle:

1. A Subscription consumer acquires demand. The service subscribes to provider events and provider
   registry changes, then starts one snapshot acquisition.
2. The snapshot is published before sparse live updates. Reconnects therefore have a complete
   record without replaying an event history.
3. While demand exists, automatic refresh is bounded to one acquisition per five minutes. Manual
   refresh bypasses freshness but joins the same per-service single-flight operation.
4. A failed refresh retains an available last-known record as `stale`. Passing a provider reset
   timestamp also marks an unrefreshed record stale; the service never resets a percentage itself.
5. Sparse updates are folded into the last complete record and published as a complete snapshot.
   A sparse event cannot create the first public record. Provider-instance generation checks prevent
   a replaced reader from publishing into its successor.
6. When the last consumer leaves Subscription, the demand-scoped event and refresh fibers close.
   The bounded in-memory last-known record may remain, but allowance history is not persisted.

The service treats provider failure as an explicit unavailable record so one failing provider does
not turn a multi-provider response into an empty or misleading success. Diagnostics retain only a
bounded outcome category and privacy-safe provider-instance identifier; raw native payloads do not
cross the service boundary.

## Provider adapters

Codex uses the configured app-server client to request `account/rateLimits/read`. The adapter keeps
Codex’s native primary/secondary windows, used-percent meaning, reset timestamps, credits, and
spending controls. Its runtime event mapper accepts sparse `account.rate-limits.updated` facts.

Claude reuses the configured executable, environment, home/configuration path, and OAuth setup
through the existing Agent SDK query. The allowance probe:

- starts a never-yielding input stream;
- waits for SDK initialization;
- feature-detects the experimental
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` control method;
- requests usage without sending a user message or making a model turn;
- applies a bounded deadline; and
- aborts and closes the query on success, unavailable response, error, timeout, or cancellation.

The provider session interface does not expose account-control requests, so the snapshot reader uses
the bounded no-turn query rather than reaching through an active conversation session. Compatible
runtime rate-limit events are reused as live updates. Cursor, Grok, and OpenCode do not currently
provide an allowance reader and are explicitly unsupported by this feature.

When Claude reports no limits, lacks the experimental method, or returns a response that cannot
provide limits, the adapter returns the stable unavailable presentation:

> Claude did not report subscription usage limits.

That result does not infer whether the account lacks a subscription, uses an API key, lacks a
scope, or encountered an outage. The owner-selected rollout of this existing configured path is
not Anthropic approval and is not a compliance determination.

## Transport and compatibility

The server exposes two additive methods in [`rpc.ts`][rpc]:

- `server.refreshSubscriptionAllowance` for explicit refresh demand; and
- `subscribeSubscriptionAllowance` for snapshot-first live delivery.

Both use the same authenticated environment access as Historical usage. The wire shape
contains allowance observations only; credentials, raw native payloads, transcripts, unmasked
emails, local configuration paths, and Claude behavior data remain inside the owning environment.

A newer client connected to an older server treats a method-not-found response as environment
compatibility, not provider authentication failure. It keeps Historical working and shows a
Subscription compatibility message for that environment. An older client ignores the additive
methods when connected to a newer server. No historical contract version bump or persistence
migration is required.

## Client reconciliation

[`subscriptionAllowance.ts`][projection] keeps every environment and provider-instance source in
the projection. Sources are grouped only when the provider reports an exact verified allowance
identity. Labels, emails, plan names, environment names, paths, or locally derived fingerprints do
not prove identity.

Grouping is a presentation view, not a merge. The projection chooses one complete whole-source
observation by deterministic freshness, completeness, delivery, connection, and source ordering;
it never combines one environment’s windows with another environment’s credits. Freshness remains
an internal selection input: card presentation models expose the observation timestamp and derived
source currentness, not raw freshness. Web and mobile communicate age with **Updated** and mark
do not expose a second currentness label. Leaving Subscription unmounts the allowance consumer,
which releases demand while leaving Historical independent.

## Evidence and release boundary

The implementation, automated tests, live provider evidence, integrated surface checks,
documentation, and release readiness are separate states. Use the
[subscription allowance release evidence checklist][release-checklist] to record them. A green
focused test or local commit is not a live-provider, browser/device, push, merge, deployment, or
release receipt. The user-visible feature is not release-ready until Codex, Claude, web/desktop,
mobile, remote/compatibility behavior, Historical regression, privacy, and required evidence gates
are all complete.

[reader]: ../../apps/server/src/provider/Services/ProviderAllowanceReader.ts
[contract]: ../../packages/contracts/src/usage.ts
[service]: ../../apps/server/src/usage/SubscriptionAllowanceService.ts
[rpc]: ../../packages/contracts/src/rpc.ts
[projection]: ../../packages/client-runtime/src/state/subscriptionAllowance.ts
[release-checklist]: ../operations/subscription-allowance-release.md
