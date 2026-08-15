# Provider Usage Left Design

**Status:** Approved in conversation on 2026-08-11

## Outcome

T3 Code will show a compact provider-usage strip directly above the existing
Usage navigation item in the bottom-left sidebar. Each enabled provider instance
appears as its brand logo followed by a whole-number percentage remaining, for
example:

`[Claude logo] 72%  [Codex logo] 100%  [Cursor logo] —`

The strip contains no visible provider names or heading. Selecting an item opens
provider-specific remaining-usage details. Codex details also expose banked
rate-limit resets and allow the user to consume one after confirmation.

## Context and Research

The existing Usage page reports historical Claude and Codex token activity by
scanning local transcripts. A remaining-quota snapshot is different data: it is
current, account-scoped, may reset on several windows, and cannot be safely
aggregated across environments.

OpenUsage provides the useful reference architecture:

- a server-side provider contract produces normalized full snapshots;
- the UI never handles provider credentials or calls provider APIs directly;
- provider polling defaults to 30 seconds;
- missing fields remain missing instead of being estimated;
- transient failures keep a provider visible with degraded status;
- detail views render every metric a provider can truthfully supply.

T3 will adopt those principles natively rather than bundle OpenUsage. A sidecar
would add another runtime, database, lifecycle, and remote-transport boundary to
an app that already has an environment server and typed WebSocket contracts.

Relevant upstream references:

- <https://openusage.sh/docs/concepts/architecture/>
- <https://openusage.sh/docs/concepts/providers/>
- <https://openusage.sh/docs/concepts/snapshots/>
- <https://github.com/janekbaraniewski/openusage>

## Goals

- Show every provider instance enabled in the primary environment's Providers
  Settings.
- Match the exact order shown in Providers Settings.
- Show a trustworthy percentage remaining when one is available.
- Show an em dash when a trustworthy percentage is unavailable, stale, or in
  error.
- Refresh current data every 30 seconds and after relevant provider events or
  successful mutations.
- Provide detailed windows, resets, balances, credits, freshness, source, and
  diagnostics on selection.
- Let eligible Codex users view and consume banked rate-limit resets safely.
- Keep credentials and provider API access on the environment server so local,
  remote, relay, and tunnel connections behave consistently.
- Support multiple configured instances of the same driver without collapsing
  them by driver kind.

## Non-goals

- Do not estimate subscription quota from token history or a synthetic budget.
- Do not scrape browser cookies or private web dashboards.
- Do not treat API request-rate headroom as a coding-subscription allowance.
- Do not aggregate percentages or reset inventories across environments or
  accounts.
- Do not add a new bottom-left surface to the React Native mobile client in this
  change. The contracts remain client-agnostic so mobile can add a suitable
  surface later.
- Do not replace the existing historical Usage page.

## Sidebar Experience

### Placement and content

The strip renders immediately above the existing Usage menu item in the shared
web sidebar footer. Desktop inherits the web surface through its Electron shell.

Each enabled provider instance renders:

1. the existing T3 brand icon for the instance's driver;
2. one space-sized visual gap;
3. either a rounded whole-number percentage such as `72%` or an em dash.

There are no visible provider names, labels, headings, colons, or separators.
Values use tabular numerals. Multiple instances of the same driver repeat the
same driver logo but expose their configured instance names to assistive
technology and tooltips.

The strip stays on one line and uses compact gaps. If its contents exceed the
current resizable sidebar width, it scrolls horizontally without expanding the
footer or wrapping the Usage and Settings items.

### Canonical ordering

Providers Settings is the only ordering authority. The ordered Settings rows are
filtered to instances whose effective `enabled` value is true. The footer must
consume the same shared ordered projection used by Providers Settings; it must
not independently sort server snapshots or enumerate driver constants.

Enabling, disabling, adding, or deleting an instance updates the footer as soon
as the settings projection changes. Custom instances retain their exact Settings
position.

### Headline percentage

Provider adapters mark quota metrics that can block the next request. The
headline is the lowest `remainingPercent` among those current blocking metrics.
Balances, historical spend, context-window utilization, and API throughput
headers are not headline candidates unless the adapter explicitly identifies
them as the provider instance's coding allowance.

The client clamps a current value to `0..100`, rounds it to the nearest whole
number, and appends `%`. It renders an em dash when:

- no blocking metric is available;
- the snapshot is stale;
- the provider returned an authentication or fetch error; or
- the source describes a different allowance from the configured coding
  provider.

### Interaction

Hovering or focusing an item shows a tooltip containing the instance display
name, headline window, and freshness. Selecting it opens an anchored detail
popover on desktop/web and a responsive sheet at small breakpoints.

The detail surface may use words. It shows, when available:

- instance display name, provider brand, and account/plan metadata;
- every quota window with remaining percentage and reset time;
- credits or balance in the provider-reported unit;
- banked reset count and detail rows;
- data source and last successful refresh;
- bounded authentication, unsupported, stale, or fetch diagnostics.

An unknown provider remains selectable. Its panel explains that the provider
does not currently expose a trustworthy remaining allowance and still shows any
non-quota activity already available from T3.

## Provider Coverage

### Codex

Codex uses the existing typed `effect-codex-app-server` protocol:

- `account/rateLimits/read` supplies primary/secondary windows, credits,
  spend-control data, multi-limit buckets, and banked reset inventory;
- `account/usage/read` supplies account token-usage summary where supported;
- `account/rateLimits/updated` invalidates or enriches a cached snapshot;
- `account/rateLimitResetCredit/consume` consumes a selected banked reset using
  a UUID idempotency key.

This is preferred over calling ChatGPT's internal `/wham/usage` route directly.
The protocol already models `availableCount`, optional reset detail rows,
expiry, status, reset type, and the consume outcomes `reset`, `nothingToReset`,
`noCredit`, and `alreadyRedeemed`.

Codex primary and secondary rate-limit windows are blocking headline candidates.
Credit balance and banked reset count remain detail fields.

### Claude

Claude uses the Agent SDK's `rate_limit_event`, which carries status,
utilization, and optional reset time. T3 already translates that message to an
`account.rate-limits.updated` runtime event. The quota service retains the
latest instance-scoped event as a current snapshot.

The SDK reports `utilization` as a `0..1` ratio. The Claude adapter multiplies
that ratio by 100 to normalize `usedPercent` to the shared `0..100` provider
scale, then computes `remainingPercent = 100 - usedPercent`.

Before a usable event arrives, or after it becomes stale, Claude renders an em
dash. Historical transcript tokens remain available on the existing Usage page
but are never converted into a quota estimate.

### Cursor

Cursor's personal dashboard shows subscription usage, but there is no stable
public personal-quota API in the current T3 authentication path. OpenUsage uses
a hybrid of local SQLite data and provider endpoints. T3 will not copy private
dashboard scraping into this feature. Cursor therefore renders an em dash until
a supported source is available; local activity may still appear in details.

### Grok

xAI API rate limits and API-key credits are not interchangeable with Grok agent
subscription usage. The current Grok driver renders an em dash unless its exact
configured runtime later supplies a coding-allowance metric. Generic xAI API
headers do not become the headline.

### OpenCode

OpenCode can route through many upstream providers, so there is no universal
OpenCode percentage. A percentage is shown only when the configured OpenCode
backend supplies a concrete allowance for that instance. Zen balance or local
token activity can appear in details but does not become a percentage without a
reported limit. Otherwise OpenCode renders an em dash.

## Contracts

Remaining-quota data uses a new contract separate from historical
`UsageSummary`. The contract is instance-aware and contains no secret values.
Its conceptual shape is:

```ts
interface ProviderQuotaSummary {
  readAt: string;
  instances: readonly ProviderQuotaSnapshot[];
}

interface ProviderQuotaSnapshot {
  instanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
  status: "current" | "unknown" | "stale" | "authRequired" | "error";
  source: string;
  readAt: string;
  headlineMetricKey: string | null;
  metrics: readonly ProviderQuotaMetric[];
  credits: ProviderQuotaCredits | null;
  bankedResets: ProviderBankedResetSummary | null;
  detail: Readonly<Record<string, string>>;
  message: string | null;
}

interface ProviderQuotaMetric {
  key: string;
  label: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  blocking: boolean;
}
```

The exact implementation will use Effect Schema, bounded strings, finite
numbers, and explicit nullable fields. A dedicated read RPC returns the summary.
A dedicated Codex mutation RPC accepts the environment, provider instance,
optional reset-credit ID, and idempotency key, and returns the typed consume
outcome.

## Server Data Flow

1. The web footer derives the primary environment and canonical ordered enabled
   instance list from server settings.
2. A shared environment-scoped query requests provider quota snapshots.
3. The server resolves enabled instances through the provider instance
   registry and asks the appropriate quota adapter for a snapshot.
4. Provider reads run concurrently with bounded timeouts; one failure cannot
   fail the whole summary.
5. The service caches full snapshots for 30 seconds per environment and
   instance. Concurrent readers share the same in-flight read.
6. The client refreshes the query every 30 seconds while the footer is mounted.
7. Provider rate-limit events and settings changes invalidate affected entries.
8. A successful Codex reset mutation invalidates the Codex entry and triggers an
   immediate refetch.

Snapshots are full state, not deltas. Sparse provider notifications merge only
inside the server adapter or cause a refetch; the client never performs
provider-specific merging.

## Banked Reset Safety

Consuming a Codex reset is an irreversible external account mutation. The detail
panel requires an explicit confirmation naming the reset and any expiry. The
action is available only for an enabled, authenticated Codex instance and an
available reset.

The client generates one UUID idempotency key per logical attempt and reuses it
for retries. While the mutation is pending, reset controls are disabled. The UI
maps every typed outcome to explicit feedback and refreshes the quota snapshot:

- `reset`: report success;
- `nothingToReset`: explain that the current window did not need resetting;
- `noCredit`: explain that no reset remains;
- `alreadyRedeemed`: explain that the selected credit was already consumed.

The server never auto-consumes a reset and never retries with a new idempotency
key.

## Failure, Privacy, and Security

- Provider credentials, access tokens, cookies, and raw provider payloads never
  cross the T3 WebSocket contract.
- Provider errors are mapped to bounded user-safe status and message fields.
- A failed adapter returns an error snapshot for only its instance.
- The last successful snapshot may be retained server-side for diagnostics, but
  stale snapshots never display a percentage in the footer.
- Unknown or older remote servers fail the quota query independently; the
  footer continues to show enabled logos with em dashes.
- Reset consumption is authorized as an orchestration-operate action; quota
  reads use orchestration-read authorization.
- No browser cookie extraction or unreviewed private dashboard endpoint is
  introduced.

## Performance and Accessibility

- Polling is one summary request per mounted client every 30 seconds, with
  server-side per-instance caching and in-flight de-duplication.
- Provider reads are concurrent and bounded so a slow CLI cannot delay other
  providers indefinitely.
- The footer performs no continuous animation or per-second countdown render.
  Reset times update on snapshot refresh.
- Icon/value items are keyboard focusable and expose an accessible label with
  instance name, percentage or unknown state, and window.
- Tooltips are supplementary; all information is reachable by focus and inside
  the detail surface.
- The strip does not wrap or cause the existing footer navigation to move as
  values refresh.

## Surface Decisions

- **Web:** full footer strip and detail interaction.
- **Desktop:** full behavior through the shared web UI; no new Electron IPC is
  required because reads and mutations use environment RPC.
- **Mobile:** no bottom-left footer exists, so no new visible entry in this
  change. Shared contracts and client-runtime query support remain reusable.
- **Providers:** Codex exact, Claude event-backed, Cursor/Grok/OpenCode honest
  unknown fallback until the configured runtime exposes a trustworthy quota.
- **Connections:** local, direct remote, relay, and tunnel all use the same
  environment RPC path.
- **Reverse state:** settings disable/delete removes an item; enabling/addition
  restores it. Reset consumption always refreshes the inventory and quota state.

## Verification

Focused automated coverage will include:

- Effect Schema decoding for current, unknown, stale, and error snapshots;
- Codex primary/secondary percentage and reset-time projection;
- Codex credits, multi-limit buckets, banked-reset inventory, and every consume
  outcome;
- idempotency-key preservation across retries;
- timeout, authentication, malformed payload, and partial-provider behavior;
- 30-second caching and concurrent-read de-duplication;
- provider-event and settings-change invalidation;
- exact Settings ordering, enabled filtering, and multiple same-driver
  instances;
- lowest-blocking-percentage selection and whole-number formatting;
- em-dash rendering for missing or stale data;
- keyboard labels, tooltip content, detail opening, confirmation, and mutation
  feedback;
- a focused server test suite, contract tests, web component tests, lint, and
  type checks for touched packages.

Browser/computer verification is excluded unless the user separately approves
it, per repository policy.

## Documentation

The existing user Usage documentation will be updated to distinguish historical
token/cost reporting from current provider allowance, explain the em dash, state
the 30-second refresh cadence, and document confirmed Codex reset consumption.
No new glossary term is required.
