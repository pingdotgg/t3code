# Provider Usage Left Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact, live provider-quota strip above the existing sidebar Usage item, ordered exactly like enabled Providers Settings rows, with trustworthy detail views and explicit Codex banked-reset consumption.

**Architecture:** Add a provider-instance quota capability at the server adapter boundary, normalize it into a new secret-free Effect Schema contract, and expose environment-scoped read/consume RPCs. The web client polls the primary environment every 30 seconds through the existing atom runtime, joins quota snapshots to the same pure ordered row projection used by Providers Settings, and renders a one-line icon/percentage strip plus popover/sheet details. Codex reads and consumes quota through the typed app-server protocol; Claude records SDK rate-limit events; unsupported providers remain visible with an em dash.

**Tech Stack:** TypeScript, Effect/Effect Schema, Effect RPC, React, Effect Atom React, Base UI popover/dialog primitives, Vitest/@effect/vitest, Tailwind CSS.

## Global Constraints

- Treat [the approved design spec](../specs/2026-08-11-provider-usage-left-design.md) as authoritative.
- Keep provider-specific interpretation in server adapter modules. Contracts and UI must remain provider-neutral.
- Never send credentials, cookies, auth headers, raw provider payloads, environment variables, or CLI configuration across the WebSocket.
- Never call ChatGPT's internal `/wham/usage` endpoint, scrape a browser profile, read Cursor's private dashboard endpoints, or infer subscription quota from unrelated API headers.
- Scope the feature to the primary environment. Do not aggregate quota across environments or accounts.
- Cache each provider-instance read for 30 seconds and share concurrent in-flight reads. A slow or failed provider must not block the other rows.
- A stale, unknown, unauthenticated, or failed snapshot always renders an em dash in the compact strip.
- Never consume a banked reset automatically. Require explicit confirmation and reuse one UUID idempotency key for retries of the same logical attempt.
- Keep the compact strip free of visible words, headings, colons, and separators. Words are allowed in tooltips and the detail surface.
- Implement the web surface once in `SidebarChromeFooter`; Electron inherits it. Do not add a React Native mobile footer in this change.
- Do not run repo-wide checks. Use only the focused tests and package typechecks listed below.
- Do not launch a dev server or browser without fresh user permission.

---

## Task 1: Define the provider-quota wire contract

**Files:**

- Create: `packages/contracts/src/providerQuota.ts`
- Create: `packages/contracts/src/providerQuota.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/rpc.ts`

### Contract shape

Implement Effect Schemas for these exact public concepts:

```ts
export const ProviderQuotaSnapshotStatus = Schema.Literals([
  "current",
  "unknown",
  "stale",
  "authRequired",
  "error",
]);

export const ProviderQuotaMetric = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  remainingPercent: Schema.NullOr(Schema.Finite),
  usedPercent: Schema.NullOr(Schema.Finite),
  resetsAt: Schema.NullOr(Schema.String),
  windowMinutes: Schema.NullOr(NonNegativeInt),
  blocking: Schema.Boolean,
});

export const ProviderQuotaCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.NullOr(Schema.String),
});

export const ProviderBankedReset = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.NullOr(TrimmedNonEmptyString),
  grantedAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  resetType: TrimmedNonEmptyString,
  status: Schema.Literals(["available", "redeeming", "redeemed", "unknown"]),
});

export const ProviderBankedResetSummary = Schema.Struct({
  availableCount: NonNegativeInt,
  resets: Schema.Array(ProviderBankedReset),
  detailsComplete: Schema.Boolean,
});

export const ProviderQuotaSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  status: ProviderQuotaSnapshotStatus,
  source: TrimmedNonEmptyString,
  readAt: Schema.String,
  lastSuccessfulReadAt: Schema.NullOr(Schema.String),
  headlineMetricKey: Schema.NullOr(TrimmedNonEmptyString),
  metrics: Schema.Array(ProviderQuotaMetric),
  credits: Schema.NullOr(ProviderQuotaCredits),
  bankedResets: Schema.NullOr(ProviderBankedResetSummary),
  detail: Schema.Record({ key: TrimmedNonEmptyString, value: Schema.String }),
  message: Schema.NullOr(Schema.String),
});

export const ProviderQuotaSummary = Schema.Struct({
  readAt: Schema.String,
  instances: Schema.Array(ProviderQuotaSnapshot),
});

export const ProviderQuotaConsumeResetInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  creditId: Schema.NullOr(TrimmedNonEmptyString),
  idempotencyKey: TrimmedNonEmptyString,
});

export const ProviderQuotaConsumeResetOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
```

Add a tagged `ProviderQuotaReadError` only for whole-service failures such as registry access; per-instance adapter failures belong in `ProviderQuotaSnapshot.status`. Add `ProviderQuotaConsumeResetError` with stable reasons `unsupported`, `instanceMissing`, `instanceDisabled`, `authRequired`, and `providerFailed`, plus a bounded user-safe `detail` string.

Add RPCs:

```ts
WS_METHODS.serverGetProviderQuota = "server.getProviderQuota";
WS_METHODS.serverConsumeProviderQuotaReset = "server.consumeProviderQuotaReset";
```

The read payload is `Schema.Struct({})`. The consume payload is `ProviderQuotaConsumeResetInput`. Add both RPCs to `WsRpcGroup`.

### Steps

- [ ] Write schema round-trip tests for a current Codex snapshot with two windows, credits, and reset details.
- [ ] Write decode tests for `unknown`, `stale`, `authRequired`, and `error` snapshots with nullable detail.
- [ ] Write rejection tests for non-finite percentages, negative reset counts, and blank instance/reset identifiers.
- [ ] Run `vp test run packages/contracts/src/providerQuota.test.ts` and confirm the new tests fail because the contract does not exist.
- [ ] Implement `providerQuota.ts`, export it from `index.ts`, and register both RPCs in `rpc.ts`.
- [ ] Run `vp test run packages/contracts/src/providerQuota.test.ts` and confirm it passes.
- [ ] Run `vp run --filter @t3tools/contracts typecheck`.
- [ ] Commit: `git add packages/contracts/src/providerQuota.ts packages/contracts/src/providerQuota.test.ts packages/contracts/src/index.ts packages/contracts/src/rpc.ts && git commit -m "feat(contracts): add provider quota RPCs"`

---

## Task 2: Make Providers Settings ordering a shared pure projection

**Files:**

- Modify: `apps/web/src/components/settings/ProviderSettingsPanel.logic.ts`
- Modify: `apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts`
- Modify: `apps/web/src/components/settings/ProviderSettingsPanel.tsx`

### Projection API

Move the existing inline row construction out of `EnvironmentProviderSettings` into a pure helper:

```ts
export interface OrderedProviderSettingsRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

export function deriveOrderedProviderSettingsRows(input: {
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers">;
  readonly driverOrder: ReadonlyArray<ProviderDriverKind>;
}): ReadonlyArray<OrderedProviderSettingsRow>;
```

Preserve the current semantics exactly:

- emit each configured/default driver slot in `DRIVER_OPTIONS` order;
- synthesize a default row from the legacy provider settings when no explicit default instance exists;
- place custom instances immediately after the default of the same driver, retaining object insertion/settings-author order;
- append explicit unknown/future driver instances after known drivers, retaining insertion order;
- preserve `isDefault` and `isDirty` behavior.

`ProviderSettingsPanel.tsx` must call this helper and render its returned rows. The later sidebar task must call the same helper and only then filter `row.instance.enabled !== false`. Do not add a second ordering implementation.

### Steps

- [ ] Add tests for known driver order, default-before-custom, two custom instances retaining author order, unknown driver append order, disabled row preservation, and legacy-default synthesis.
- [ ] Run `vp test run apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts` and confirm the new tests fail.
- [ ] Implement `deriveOrderedProviderSettingsRows` by moving, not duplicating, the existing logic.
- [ ] Replace the inline row-building block in `ProviderSettingsPanel.tsx` with the shared helper using the current visible `DRIVER_OPTIONS`-derived driver list.
- [ ] Run `vp test run apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts apps/web/src/components/settings/ProviderSettingsPanel.environment.test.tsx`.
- [ ] Run `vp run --filter @t3tools/web typecheck`.
- [ ] Commit: `git add apps/web/src/components/settings/ProviderSettingsPanel.logic.ts apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts apps/web/src/components/settings/ProviderSettingsPanel.tsx && git commit -m "refactor(web): share provider settings order"`

---

## Task 3: Add the server-side quota capability and normalization helpers

**Files:**

- Create: `apps/server/src/provider/ProviderQuota.ts`
- Create: `apps/server/src/provider/ProviderQuota.test.ts`
- Modify: `apps/server/src/provider/ProviderDriver.ts`

### Capability API

Use a plain captured record, matching the existing `ProviderInstance` design:

```ts
export interface ProviderQuotaCapability {
  readonly read: Effect.Effect<ProviderQuotaSnapshot, ProviderQuotaAdapterError>;
  /** Monotonic per-instance generation; provider events increment it to bypass cached reads. */
  readonly revision: Effect.Effect<number>;
  readonly consumeBankedReset?: (
    input: Pick<ProviderQuotaConsumeResetInput, "creditId" | "idempotencyKey">,
  ) => Effect.Effect<ProviderQuotaConsumeResetOutcome, ProviderQuotaAdapterError>;
}

export class ProviderQuotaAdapterError extends Schema.TaggedErrorClass<ProviderQuotaAdapterError>()(
  "ProviderQuotaAdapterError",
  {
    reason: Schema.Literals(["authRequired", "timeout", "unsupported", "providerFailed"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
```

Add `readonly quota?: ProviderQuotaCapability` to `ProviderInstance`. Optionality is deliberate: Cursor, Grok, OpenCode, unavailable shadows, and future drivers need no fake implementation.

Every supported capability owns an instance-scoped revision `Ref`, initialized to zero. Provider rate-limit events increment it. The summary service includes the current revision and provider-instance object identity in its cache entry, so a changed revision or rebuilt instance bypasses the cached snapshot without coupling adapters to the service layer.

Add pure helpers in the same module:

- `remainingPercentFromUsed(usedPercent)` clamps `100 - usedPercent` to `0..100` but does not round;
- `resolveHeadlineMetricKey(metrics)` selects the blocking metric with the lowest non-null remaining percentage;
- `unknownProviderQuotaSnapshot(instance, readAt, message?)` creates the honest unsupported fallback;
- `errorProviderQuotaSnapshot(instance, readAt, error, previous?)` retains only safe normalized detail and marks any previous successful data stale.

The UI will perform final whole-number rounding. The server keeps finite provider precision.

### Steps

- [ ] Add unit tests for clamping, lowest blocking metric selection, ignoring non-blocking credits/spend detail, unknown snapshots, and stale fallback after a failed read.
- [ ] Run `vp test run apps/server/src/provider/ProviderQuota.test.ts` and confirm failure.
- [ ] Implement the capability, helpers, tagged error, and optional `ProviderInstance.quota` field.
- [ ] Run `vp test run apps/server/src/provider/ProviderQuota.test.ts apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts`.
- [ ] Run `vp run --filter t3 typecheck`.
- [ ] Commit: `git add apps/server/src/provider/ProviderQuota.ts apps/server/src/provider/ProviderQuota.test.ts apps/server/src/provider/ProviderDriver.ts && git commit -m "feat(server): add provider quota capability"`

---

## Task 4: Implement typed Codex quota reads and banked-reset consumption

**Files:**

- Create: `apps/server/src/provider/Drivers/CodexProviderQuota.ts`
- Create: `apps/server/src/provider/Drivers/CodexProviderQuota.test.ts`
- Modify: `apps/server/src/provider/Layers/CodexProvider.ts`
- Modify: `apps/server/src/provider/Drivers/CodexDriver.ts`
- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts`
- Modify: `apps/server/src/provider/Layers/CodexAdapter.test.ts`

### Reuse the typed app-server client

Extract the short-lived spawn/initialize setup currently embedded in `probeCodexAppServerProvider` into an exported scoped helper in `CodexProvider.ts`. It must preserve:

- `resolveSpawnCommand` and `codexAppServerArgs`;
- per-instance `binaryPath`, `launchArgs`, resolved `CODEX_HOME`, process environment, and server `cwd`;
- `forceKillAfter` and scoped child cleanup;
- typed `CodexAppServerClient` initialization with `experimentalApi: true` and the existing `initialized` notification.

Both the existing provider probe and the new quota module must use this helper. Do not duplicate process startup or home resolution.

### Codex normalization

`makeCodexProviderQuota` accepts the effective `CodexSettings`, per-instance environment, `instanceId`, and the captured `ChildProcessSpawner`. Its `read` calls:

```ts
client.request("account/rateLimits/read", undefined)
```

Normalize the generated response as follows:

- `rateLimits.primary` becomes metric key `primary`, label based on `windowDurationMins` when available, `remainingPercent = 100 - usedPercent`, and `blocking: true`;
- `rateLimits.secondary` becomes `secondary` with the same rules;
- `rateLimits.individualLimit` becomes a blocking `individualLimit` metric using its reported `remainingPercent`;
- entries in `rateLimitsByLimitId` become stable keys `limit:<id>:primary`, `limit:<id>:secondary`, and `limit:<id>:individual`, using provider names only as labels;
- numeric Unix reset timestamps become ISO strings;
- `credits.balance` stays a string to avoid currency/precision assumptions;
- `rateLimitResetCredits.availableCount` is preserved even when details are null or capped;
- reset details preserve only id/title/description/timestamps/type/status;
- account/plan/rate-limit-reached metadata becomes a bounded string record;
- `headlineMetricKey` comes from the lowest current blocking remaining percent.

The consume closure calls:

```ts
client.request("account/rateLimitResetCredit/consume", {
  creditId: input.creditId,
  idempotencyKey: input.idempotencyKey,
})
```

Return the generated typed outcome without translation. Never retry inside the server with a new key.

### Sparse runtime updates

Add an optional `onRateLimitsUpdated` callback to `CodexAdapterLiveOptions`, typed from `V2AccountRateLimitsUpdatedNotification`. Invoke it after schema validation when `account/rateLimits/updated` arrives and before emitting the existing canonical runtime event. `CodexProviderQuota` uses the callback only to invalidate its 30-second cache; full snapshots still come from `account/rateLimits/read`.

### Steps

- [ ] Add normalization tests with primary/secondary windows, spend control, credits, multi-limit buckets, null reset details, capped reset details, and out-of-range used percentages.
- [ ] Add consume tests for all four outcomes and assert the exact credit ID/idempotency key sent to the typed client.
- [ ] Add adapter tests proving a validated sparse notification calls `onRateLimitsUpdated` once and malformed input does not.
- [ ] Run `vp test run apps/server/src/provider/Drivers/CodexProviderQuota.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts` and confirm the new tests fail.
- [ ] Extract the shared scoped app-server client helper and keep the existing Codex provider probe tests green.
- [ ] Implement `CodexProviderQuota`, wire it into `CodexDriver`, and pass its invalidation callback to `makeCodexAdapter`.
- [ ] Run `vp test run apps/server/src/provider/Drivers/CodexProviderQuota.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/provider/Layers/CodexProvider.test.ts`.
- [ ] Run `vp test run packages/effect-codex-app-server/src/protocol.test.ts` to preserve the generated protocol evidence for banked resets.
- [ ] Run `vp run --filter t3 typecheck`.
- [ ] Commit: `git add apps/server/src/provider/Drivers/CodexProviderQuota.ts apps/server/src/provider/Drivers/CodexProviderQuota.test.ts apps/server/src/provider/Layers/CodexProvider.ts apps/server/src/provider/Drivers/CodexDriver.ts apps/server/src/provider/Layers/CodexAdapter.ts apps/server/src/provider/Layers/CodexAdapter.test.ts && git commit -m "feat(server): read Codex quota and banked resets"`

---

## Task 5: Capture Claude SDK rate-limit events per provider instance

**Files:**

- Create: `apps/server/src/provider/Drivers/ClaudeProviderQuota.ts`
- Create: `apps/server/src/provider/Drivers/ClaudeProviderQuota.test.ts`
- Modify: `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

### Event-backed source

Define the SDK event type without re-declaring provider fields:

```ts
type ClaudeRateLimitEvent = Extract<SDKMessage, { readonly type: "rate_limit_event" }>;
```

`makeClaudeProviderQuota(instanceId)` creates instance-scoped `Ref`s containing the last normalized event and monotonic revision, and returns:

```ts
{
  quota: ProviderQuotaCapability;
  recordRateLimitEvent: (event: ClaudeRateLimitEvent) => Effect.Effect<void>;
}
```

Normalize only SDK-reported fields:

- a finite `utilization` is a blocking metric with `remainingPercent = 100 - utilization`;
- `resetsAt` becomes an ISO reset timestamp when valid;
- `status` and other safe enum/text metadata appear in `detail`;
- before the first event, return `unknown` with source `claude-agent-sdk`;
- keep the last event current until its reset boundary or 30 minutes, whichever comes first; after that return the same data with `status: "stale"` and no footer percentage;
- do not derive a percentage from historical transcript tokens.

Add `onRateLimitEvent?: (event: ClaudeRateLimitEvent) => Effect.Effect<void>` to `ClaudeAdapterLiveOptions`. Invoke it before emitting the existing `account.rate-limits.updated` runtime event. `ClaudeDriver` creates the tracker, passes the callback, and assigns `quota` on its `ProviderInstance`.

### Steps

- [ ] Add tracker tests for pre-event unknown, utilization normalization, reset timestamp, stale transition, and malformed/absent utilization.
- [ ] Add adapter tests proving a `rate_limit_event` updates both the callback and existing runtime event stream.
- [ ] Run `vp test run apps/server/src/provider/Drivers/ClaudeProviderQuota.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts` and confirm failure.
- [ ] Implement the tracker and adapter callback.
- [ ] Wire the tracker into `ClaudeDriver` without sharing mutable state between instances.
- [ ] Run `vp test run apps/server/src/provider/Drivers/ClaudeProviderQuota.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts`.
- [ ] Run `vp run --filter t3 typecheck`.
- [ ] Commit: `git add apps/server/src/provider/Drivers/ClaudeProviderQuota.ts apps/server/src/provider/Drivers/ClaudeProviderQuota.test.ts apps/server/src/provider/Drivers/ClaudeDriver.ts apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts && git commit -m "feat(server): track Claude quota events"`

---

## Task 6: Build the cached quota service and authorize its RPC handlers

**Files:**

- Create: `apps/server/src/provider/Services/ProviderQuotaService.ts`
- Create: `apps/server/src/provider/Services/ProviderQuotaService.test.ts`
- Modify: `apps/server/src/auth/RpcAuthorization.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts`

### Service behavior

Create `ProviderQuotaService` as an Effect `Context.Service` with:

```ts
readonly readSummary: Effect.Effect<ProviderQuotaSummary, ProviderQuotaReadError>;
readonly consumeBankedReset: (
  input: ProviderQuotaConsumeResetInput,
) => Effect.Effect<ProviderQuotaConsumeResetOutcome, ProviderQuotaConsumeResetError>;
readonly invalidate: (instanceId?: ProviderInstanceId) => Effect.Effect<void>;
```

Implementation rules:

- obtain instances from `ProviderInstanceRegistry.listInstances`, preserving registry identity but not relying on its order for UI display;
- include one snapshot for every enabled instance;
- for instances without `quota`, return `unknownProviderQuotaSnapshot` with source `unsupported`;
- run supported reads concurrently with a bounded concurrency of 3 and a 10-second timeout per instance;
- cache full snapshots by instance ID for 30 seconds with shared in-flight reads;
- store the capability revision and provider-instance object identity with each cache entry, bypassing it when either changes;
- retain the last successful snapshot for stale diagnostics when a refresh fails;
- invalidate removed/rebuilt instances by listening to registry changes or comparing current instance identities on every summary read;
- `consumeBankedReset` performs an exact instance lookup, verifies enabled state and capability support, invokes the capability once, then invalidates that instance on every typed outcome;
- map adapter errors to bounded safe contract errors and never include process arguments, paths, environment values, or raw payloads.

### RPC and layers

- Map `serverGetProviderQuota` to `AuthOrchestrationReadScope`.
- Map `serverConsumeProviderQuotaReset` to `AuthOrchestrationOperateScope`.
- Acquire `ProviderQuotaService` in `ws.ts` and add observed handlers alongside `serverGetUsageSummary`.
- Provide the live layer after `ProviderInstanceRegistryHydrationLive` in `RuntimeDependenciesLive`.
- Add a `layerTest`/mock service and provide it in `server.test.ts` anywhere `UsageService.layerTest` is currently supplied, so unrelated route tests do not acquire real CLIs.

### Steps

- [ ] Add service tests for enabled-only reads, unsupported unknowns, independent provider failure, 10-second timeout mapping with `TestClock`, cache reuse, in-flight de-duplication, expiry/invalidation, stale retention, instance-not-found, disabled instance, unsupported consume, exact consume forwarding, and post-consume invalidation.
- [ ] Add authorization table assertions for read versus operate scopes.
- [ ] Add focused WebSocket route tests for read success, consume success, and missing operate scope.
- [ ] Run `vp test run apps/server/src/provider/Services/ProviderQuotaService.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/server.test.ts` and confirm the new tests fail.
- [ ] Implement the service, handlers, authorization, and live/test layer composition.
- [ ] Run `vp test run apps/server/src/provider/Services/ProviderQuotaService.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/server.test.ts`.
- [ ] Run `vp run --filter t3 typecheck`.
- [ ] Commit: `git add apps/server/src/provider/Services/ProviderQuotaService.ts apps/server/src/provider/Services/ProviderQuotaService.test.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/ws.ts apps/server/src/server.ts apps/server/src/server.test.ts && git commit -m "feat(server): expose cached provider quota"`

---

## Task 7: Add primary-environment quota state and 30-second live refresh

**Files:**

- Modify: `packages/client-runtime/src/state/server.ts`
- Create: `apps/web/src/state/providerQuota.ts`
- Create: `apps/web/src/state/providerQuota.test.ts`
- Modify: `apps/web/src/hooks/useLiveRefresh.ts`
- Modify: `apps/web/src/hooks/useLiveRefresh.test.ts`

### Client runtime atoms

Add to `serverEnvironment`:

```ts
providerQuota: createEnvironmentRpcQueryAtomFamily(runtime, {
  label: "environment-data:server:provider-quota",
  tag: WS_METHODS.serverGetProviderQuota,
  staleTimeMs: 30_000,
}),

consumeProviderQuotaReset: createEnvironmentRpcCommand(runtime, {
  label: "environment-data:server:consume-provider-quota-reset",
  tag: WS_METHODS.serverConsumeProviderQuotaReset,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
  },
}),
```

### Web hook

Create `usePrimaryProviderQuota()` that:

- reads only `usePrimaryEnvironmentId()`;
- reads the matching `serverEnvironment.providerQuota` atom when present;
- returns `{summary, isPending, error, refresh, consumeReset}` with no thrown UI errors;
- refreshes the exact environment query after a settings projection change and after every consume outcome;
- creates a UUID with `crypto.randomUUID()` once per logical reset attempt in the detail component; retries reuse the stored key.

Generalize `useLiveRefresh` with optional `intervalMs` and `minimumIntervalMs`, defaulting to the existing constants so existing callers do not change. The quota hook calls it with `intervalMs: 30_000` and `minimumIntervalMs: 10_000`. Preserve visibility/focus/idle behavior so hidden or abandoned windows stop polling.

When an older remote server does not recognize the quota RPC, return `summary: null` and let enabled rows render em dashes.

### Steps

- [ ] Extend `useLiveRefresh` tests to prove default timing is unchanged and a 30-second override schedules the quota cadence without refreshing hidden/idle windows.
- [ ] Add pure state tests for success, pending, older-server failure, explicit refresh, and post-consume refresh.
- [ ] Run `vp test run apps/web/src/hooks/useLiveRefresh.test.ts apps/web/src/state/providerQuota.test.ts` and confirm failure.
- [ ] Add the client-runtime query/command and implement the web state hook.
- [ ] Run `vp test run apps/web/src/hooks/useLiveRefresh.test.ts apps/web/src/state/providerQuota.test.ts`.
- [ ] Run `vp run --filter @t3tools/client-runtime typecheck`.
- [ ] Run `vp run --filter @t3tools/web typecheck`.
- [ ] Commit: `git add packages/client-runtime/src/state/server.ts apps/web/src/state/providerQuota.ts apps/web/src/state/providerQuota.test.ts apps/web/src/hooks/useLiveRefresh.ts apps/web/src/hooks/useLiveRefresh.test.ts && git commit -m "feat(web): poll primary provider quota"`

---

## Task 8: Build the compact strip and provider detail surface

**Files:**

- Create: `apps/web/src/components/sidebar/ProviderUsageStrip.tsx`
- Create: `apps/web/src/components/sidebar/ProviderUsageStrip.logic.ts`
- Create: `apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts`
- Create: `apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx`
- Create: `apps/web/src/components/sidebar/ProviderQuotaDetails.tsx`
- Create: `apps/web/src/components/sidebar/ProviderQuotaDetails.test.tsx`
- Modify: `apps/web/src/components/sidebar/SidebarChrome.tsx`
- Reuse: `apps/web/src/components/chat/providerIconUtils.ts`
- Reuse: `apps/web/src/components/ui/popover.tsx`
- Reuse: `apps/web/src/components/ui/sheet.tsx`
- Reuse: `apps/web/src/components/ui/alert-dialog.tsx`
- Reuse: `apps/web/src/components/ui/tooltip.tsx`

### Pure display projection

Implement and test these pure helpers before JSX:

```ts
export interface ProviderUsageStripItem {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly percentage: number | null;
  readonly headlineLabel: string | null;
  readonly snapshot: ProviderQuotaSnapshot | null;
}

export function buildProviderUsageStripItems(input: {
  readonly rows: ReadonlyArray<OrderedProviderSettingsRow>;
  readonly summary: ProviderQuotaSummary | null;
}): ReadonlyArray<ProviderUsageStripItem>;
```

Rules:

- filter to effective enabled rows after canonical Settings ordering;
- exact-match snapshots by `instanceId`, never by driver kind;
- preserve duplicate same-driver instances as separate items;
- select only `snapshot.headlineMetricKey` when `snapshot.status === "current"` and the selected metric is blocking;
- clamp to `0..100`, round with `Math.round`, and use null for all other cases;
- resolve display name from configured instance name first, then driver display name, then instance ID;
- missing summary or snapshot produces null percentage rather than hiding the enabled provider.

### Compact strip markup

Insert `<ProviderUsageStrip />` inside `SidebarChromeFooter`, directly before the existing `SidebarMenuItem` containing `Usage`.

The expanded strip must:

- be a single non-wrapping horizontal row with hidden/quiet horizontal overflow;
- render each item as a focusable button containing only the existing provider logo component and either `{percentage}%` or `—`;
- use tabular numerals and compact, stable widths so live updates do not move footer navigation;
- expose `aria-label="<instance>: <n>% remaining, <window>"` or `"<instance>: usage remaining unavailable"`;
- show the same content plus freshness in a tooltip;
- avoid spinners and continuous animation.

Use the existing `PROVIDER_ICON_BY_PROVIDER`. For an unknown future driver without a mapped brand icon, render the existing generic provider fallback icon rather than text.

On sidebar widths that cannot show all items, keep the row one line and horizontally scrollable. Do not wrap or increase footer height. In icon-collapsed sidebar mode, keep each item accessible through the same horizontal viewport; do not replace the requested logo/value content with provider names.

### Detail surface

Clicking an item opens:

- an anchored `Popover` aligned above/start on normal desktop/web widths;
- a bottom/side `Sheet` at the repository's existing mobile breakpoint.

The content may use words and shows only available fields:

- provider icon, instance display name, status/source, and last successful read;
- all metrics with remaining/used percentages, reset time, and window length;
- credits/balance and unlimited state;
- banked reset count and reset detail rows;
- safe detail metadata and bounded status message;
- an honest unsupported message for unknown snapshots.

For available Codex resets:

- show a `Use reset` button only when the reset status is `available` and the current session has operate access;
- open `AlertDialog` confirmation naming the reset and expiry;
- generate and retain one `crypto.randomUUID()` idempotency key when the dialog confirms;
- disable all reset controls while the command is pending;
- map `reset`, `nothingToReset`, `noCredit`, and `alreadyRedeemed` to explicit toast/detail feedback;
- reuse the same idempotency key if the user retries the same failed logical attempt, and clear it only after a typed terminal outcome or dialog cancellation;
- refresh quota immediately after every typed outcome.

### Steps

- [ ] Add logic tests for exact Settings order, disabled filtering, duplicate logos/instances, instance-ID joins, rounding/clamping, stale/error/auth/unknown dashes, and missing old-server summary.
- [ ] Add static render tests for logo plus `100%`, logo plus em dash, absence of visible provider names/headings in the strip, accessible labels, detailed metric rows, and reset confirmation copy.
- [ ] Add server-render assertions in the two `.test.tsx` files, keeping event-state transitions in exported pure logic where DOM interaction is unnecessary.
- [ ] Run `vp test run apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/components/sidebar/ProviderQuotaDetails.test.tsx` and confirm failure.
- [ ] Implement the pure projection and compact strip.
- [ ] Implement the responsive detail surface and explicit reset flow.
- [ ] Mount it immediately above Usage in `SidebarChromeFooter` so both new and legacy sidebar shells receive the shared footer behavior.
- [ ] Run `vp test run apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/components/sidebar/ProviderQuotaDetails.test.tsx`.
- [ ] Run `vp run --filter @t3tools/web typecheck`.
- [ ] Run `vp fmt --check apps/web/src/components/sidebar/ProviderUsageStrip.tsx apps/web/src/components/sidebar/ProviderUsageStrip.logic.ts apps/web/src/components/sidebar/ProviderQuotaDetails.tsx apps/web/src/components/sidebar/SidebarChrome.tsx`.
- [ ] Commit: `git add apps/web/src/components/sidebar/ProviderUsageStrip.tsx apps/web/src/components/sidebar/ProviderUsageStrip.logic.ts apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/components/sidebar/ProviderQuotaDetails.tsx apps/web/src/components/sidebar/ProviderQuotaDetails.test.tsx apps/web/src/components/sidebar/SidebarChrome.tsx && git commit -m "feat(web): show provider usage remaining"`

---

## Task 9: Document behavior and perform focused end-to-end verification

**Files:**

- Create: `docs/user/provider-usage-remaining.md`
- Modify: `docs/README.md`
- Review: all files changed in Tasks 1–8

### User documentation

Document shipped behavior in product language:

- where the logo/percentage strip appears;
- why a provider may show an em dash;
- that order follows enabled Providers Settings rows;
- what Codex and Claude can report today;
- that Cursor, Grok, and OpenCode stay visible but may not expose trustworthy allowance data;
- how Codex banked resets work, including confirmation and the fact that consumption cannot be undone;
- primary-device/environment scope and 30-second refresh behavior.

Do not mention source paths, repository tooling, OpenUsage implementation details, or internal endpoints in user docs.

### Verification matrix

- [ ] Run all focused quota tests together:

  ```powershell
  vp test run packages/contracts/src/providerQuota.test.ts apps/server/src/provider/ProviderQuota.test.ts apps/server/src/provider/Drivers/CodexProviderQuota.test.ts apps/server/src/provider/Drivers/ClaudeProviderQuota.test.ts apps/server/src/provider/Services/ProviderQuotaService.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts apps/web/src/state/providerQuota.test.ts apps/web/src/hooks/useLiveRefresh.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/components/sidebar/ProviderQuotaDetails.test.tsx
  ```

- [ ] Run only affected package typechecks:

  ```powershell
  vp run --filter @t3tools/contracts typecheck
  vp run --filter @t3tools/client-runtime typecheck
  vp run --filter t3 typecheck
  vp run --filter @t3tools/web typecheck
  ```

- [ ] Run `git diff --check`.
- [ ] Review the final diff for secret-bearing fields, provider-specific logic outside adapters, accidental environment aggregation, unrelated refactors, animations, and duplicate Settings ordering logic.
- [ ] Walk the surface matrix explicitly:
  - web: implemented in shared sidebar footer;
  - desktop: inherited from web/Electron wrapper;
  - mobile: intentionally no new React Native footer, contracts remain reusable;
  - Codex: exact app-server read/consume plus cache invalidation;
  - Claude: SDK event-backed reporting;
  - Cursor/Grok/OpenCode: honest unknown fallback;
  - local/remote/tunnel: environment-scoped RPC uses the existing authenticated WebSocket path;
  - older remote server: enabled logos remain and show em dashes.
- [ ] Ask the user for permission before starting the isolated T3 dev server/browser pass required for a visual check.
- [ ] If permission is granted, use the repository `test-t3-app` skill once from the primary agent, seed only worktree-local test data, verify expanded/collapsed sidebar, narrow responsive sheet, provider order, unknown state, popover keyboard access, and the reset confirmation without actually consuming a real reset. Capture before/after evidence only if the user later asks for a PR.
- [ ] Add/update the user documentation.
- [ ] Commit: `git add docs/user/provider-usage-remaining.md docs/README.md && git commit -m "docs: explain provider usage remaining"`

## Final acceptance criteria

- [ ] Every enabled provider instance appears once, in exact Providers Settings order.
- [ ] The compact surface contains only provider logos and percentage/em-dash values.
- [ ] Current blocking metrics produce clamped rounded percentages; all untrustworthy states produce em dashes.
- [ ] Clicking every item, including unknown items, opens usable details.
- [ ] Codex shows all reported windows, credits, and banked reset inventory and can consume a selected reset only after confirmation.
- [ ] Claude updates from SDK rate-limit events without inventing historical quota.
- [ ] Cursor, Grok, and OpenCode do not use private or misleading quota sources.
- [ ] Reads are primary-environment scoped, cached/de-duplicated for 30 seconds, bounded, and isolated per provider failure.
- [ ] Credentials and raw provider payloads never cross the contract.
- [ ] Web and desktop are covered; mobile is an explicit non-applicable UI surface for this change.
- [ ] Focused tests, affected package typechecks, and `git diff --check` pass with current evidence.
