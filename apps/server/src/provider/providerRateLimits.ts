/**
 * providerRateLimits - Normalizes provider-native account rate-limit payloads
 * into `ServerProvider.rateLimits` so plan quota reaches the client over the
 * existing config-push pipeline.
 *
 * Providers report quota per rolling window (Claude: 5h + weekly; Codex:
 * primary + secondary). Claude has two sources with different shapes — the
 * per-turn `rate_limit_event` (one window each) and the `/usage` control read
 * (every window at once) — so windows are merged by label across payloads
 * rather than replaced.
 *
 * @module provider/providerRateLimits
 */
import type { ServerProvider, ServerProviderRateLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type RateLimitWindow = ServerProviderRateLimits["windows"][number];

/** Epoch value of unknown unit (seconds or ms) -> ISO string. */
export function epochToIso(epoch: number | null | undefined): string | undefined {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) {
    return undefined;
  }
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

/** Already-ISO timestamp (Claude's control read) -> validated ISO string. */
export function isoToIso(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : DateTime.formatIso(DateTime.makeUnsafe(parsed));
}

/**
 * Percent used, clamped to 0-100.
 *
 * Every source documents this as a 0-100 percentage: Codex's `usedPercent` is
 * an int32 0-100, and Claude's control-read `utilization` is documented
 * "Percentage of the window used, 0-100". The undocumented one is the
 * `rate_limit_event` `utilization` — if it turns out to be a 0-1 fraction,
 * this is the single place to scale it.
 */
export function toUsedPercent(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

// Shortest window first, so the meter reads "what stops me now" -> "what
// stops me this week". Labels not listed sort last, alphabetically.
const WINDOW_ORDER: ReadonlyArray<string> = [
  "5h",
  "Weekly",
  "Weekly (Opus)",
  "Weekly (Sonnet)",
  "Weekly (Apps)",
  "Overage",
];

function windowRank(label: string | undefined): number {
  const index = WINDOW_ORDER.indexOf(label ?? "");
  return index === -1 ? WINDOW_ORDER.length : index;
}

function sortWindows(windows: ReadonlyArray<RateLimitWindow>): Array<RateLimitWindow> {
  return [...windows].sort(
    (left, right) =>
      windowRank(left.label) - windowRank(right.label) ||
      (left.label ?? "").localeCompare(right.label ?? ""),
  );
}

/**
 * Merges two rate-limit views, keyed by window label, with `override` winning
 * for labels present in both. Windows only present in `base` survive — that is
 * what keeps the 5h window alive when a weekly-only event arrives.
 *
 * An `override` with zero windows is authoritative rather than a no-op: it is
 * how a provider says "plan limits do not apply to this account", so it clears
 * anything accumulated earlier.
 */
export function mergeRateLimits(
  base: ServerProviderRateLimits | undefined,
  override: ServerProviderRateLimits | undefined,
): ServerProviderRateLimits {
  const planType = override?.planType ?? base?.planType;
  const updatedAt = override?.updatedAt ?? base?.updatedAt;
  const carry = (windows: Array<RateLimitWindow>): ServerProviderRateLimits => ({
    ...(planType ? { planType } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    windows,
  });

  if (override && override.windows.length === 0) {
    return carry([]);
  }

  const byLabel = new Map<string, RateLimitWindow>();
  for (const window of base?.windows ?? []) {
    byLabel.set(window.label ?? "", window);
  }
  for (const window of override?.windows ?? []) {
    byLabel.set(window.label ?? "", window);
  }
  return carry(sortWindows([...byLabel.values()]));
}

const CLAUDE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  seven_day_oauth_apps: "Weekly (Apps)",
  overage: "Overage",
};

interface ClaudeRateLimitInfo {
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
  readonly utilization?: number;
}

/**
 * Normalizes a Claude Agent SDK `rate_limit_event`. Each event carries exactly
 * one window (`rateLimitType`), so callers must merge rather than replace.
 */
export function normalizeClaudeRateLimitInfo(
  payload: unknown,
): ServerProviderRateLimits | undefined {
  const info = (payload as { rate_limit_info?: ClaudeRateLimitInfo } | undefined)?.rate_limit_info;
  const usedPercent = toUsedPercent(info?.utilization);
  if (usedPercent === undefined) {
    return undefined;
  }
  const rawType = info?.rateLimitType;
  const label = rawType ? (CLAUDE_WINDOW_LABELS[rawType] ?? rawType) : undefined;
  const resetsAt = epochToIso(info?.resetsAt);
  return {
    windows: [
      {
        ...(label ? { label } : {}),
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
      },
    ],
  };
}

interface ClaudeUsageWindow {
  readonly utilization?: number | null;
  readonly resets_at?: string | null;
}

interface ClaudeExtraUsage {
  readonly is_enabled?: boolean;
  readonly utilization?: number | null;
}

interface ClaudeUsageResponse {
  readonly subscription_type?: string | null;
  readonly rate_limits_available?: boolean;
  readonly rate_limits?:
    | (Readonly<Record<string, ClaudeUsageWindow | null | undefined>> & {
        readonly extra_usage?: ClaudeExtraUsage | null;
      })
    | null;
}

/**
 * Normalizes the Claude `/usage` control read, which reports every plan window
 * at once with ISO reset timestamps — unlike the event path's single window and
 * epoch timestamps.
 *
 * Returns an empty window list (rather than `undefined`) when the account has
 * no plan limits at all, so the client can tell "does not apply here" apart
 * from "nothing reported yet".
 */
export function normalizeClaudeUsageResponse(
  payload: unknown,
): ServerProviderRateLimits | undefined {
  const response = payload as ClaudeUsageResponse | undefined;
  if (!response || !("rate_limits" in response)) {
    return undefined;
  }

  const planType = response.subscription_type ?? undefined;
  const base = planType ? { planType } : {};
  if (response.rate_limits_available === false || !response.rate_limits) {
    return { ...base, windows: [] };
  }

  const windows: Array<RateLimitWindow> = [];
  for (const [key, label] of Object.entries(CLAUDE_WINDOW_LABELS)) {
    const window = response.rate_limits[key];
    const usedPercent = toUsedPercent(window?.utilization);
    if (usedPercent === undefined) {
      continue;
    }
    const resetsAt = isoToIso(window?.resets_at);
    windows.push({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  }

  // Overage only exists once the plan is exhausted and the user opted in, so
  // it earns a row only while it is actually the thing gating them.
  const extraUsage = response.rate_limits.extra_usage;
  const overagePercent = toUsedPercent(extraUsage?.utilization);
  if (extraUsage?.is_enabled === true && overagePercent !== undefined && overagePercent > 0) {
    windows.push({ label: "Overage", usedPercent: overagePercent });
  }

  return { ...base, windows: sortWindows(windows) };
}

/**
 * Dispatches whichever Claude rate-limit payload arrived on the side channel.
 * Both shapes share one PubSub, and they are told apart by key: the control
 * read has `rate_limits`, the turn event has `rate_limit_info`.
 */
export function normalizeClaudeRateLimitPayload(
  payload: unknown,
): ServerProviderRateLimits | undefined {
  if (payload && typeof payload === "object" && "rate_limits" in payload) {
    return normalizeClaudeUsageResponse(payload);
  }
  return normalizeClaudeRateLimitInfo(payload);
}

const MINUTES_PER_WEEK = 10_080;
const MINUTES_PER_DAY = 1_440;

function codexWindowLabel(minutes: number | null | undefined, fallback: string): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return fallback;
  }
  if (minutes % MINUTES_PER_WEEK === 0) {
    const weeks = minutes / MINUTES_PER_WEEK;
    return weeks === 1 ? "Weekly" : `${weeks}w`;
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    const days = minutes / MINUTES_PER_DAY;
    return days === 1 ? "Daily" : `${days}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

interface CodexRateLimitWindow {
  readonly usedPercent?: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

interface CodexRateLimitSnapshot {
  readonly planType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

/**
 * Normalizes a Codex app-server rate-limit snapshot — the `rateLimits` field
 * shared by the `account/rateLimits/updated` notification and the
 * `account/rateLimits/read` response. Both windows arrive together, so a
 * single snapshot already carries the full picture.
 */
export function normalizeCodexRateLimitSnapshot(
  payload: unknown,
): ServerProviderRateLimits | undefined {
  const snapshot = payload as CodexRateLimitSnapshot | undefined;
  const windows: Array<RateLimitWindow> = [];
  for (const [fallback, window] of [
    ["Primary", snapshot?.primary],
    ["Secondary", snapshot?.secondary],
  ] as const) {
    const usedPercent = toUsedPercent(window?.usedPercent);
    if (usedPercent === undefined) {
      continue;
    }
    const resetsAt = epochToIso(window?.resetsAt);
    windows.push({
      label: codexWindowLabel(window?.windowDurationMins, fallback),
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) {
    return undefined;
  }
  return {
    ...(snapshot?.planType ? { planType: snapshot.planType } : {}),
    windows: sortWindows(windows),
  };
}

/** Stamps a normalized view with the time it was observed. */
export const stampUpdatedAt = (
  rateLimits: ServerProviderRateLimits,
): Effect.Effect<ServerProviderRateLimits> =>
  Effect.map(DateTime.now, (now) => ({ ...rateLimits, updatedAt: DateTime.formatIso(now) }));

/**
 * Tracks account rate limits from a provider's `rateLimitEvents` channel and
 * republishes the snapshot as they change.
 *
 * `store` outlives the enrichment fiber (which `makeManagedServerProvider`
 * restarts on every refresh), so accumulated windows survive a refresh that
 * rebuilt the snapshot without them.
 */
export const streamRateLimitUpdates = Effect.fn("streamRateLimitUpdates")(function* (input: {
  readonly events: Stream.Stream<unknown>;
  readonly store: Ref.Ref<ServerProviderRateLimits | undefined>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly normalize: (payload: unknown) => ServerProviderRateLimits | undefined;
}) {
  const restored = yield* Ref.get(input.store);
  if (restored) {
    const snapshot = yield* input.getSnapshot;
    yield* input.publishSnapshot({
      ...snapshot,
      rateLimits: mergeRateLimits(restored, snapshot.rateLimits),
    });
  }

  yield* Stream.runForEach(input.events, (payload) =>
    Effect.gen(function* () {
      const next = input.normalize(payload);
      if (!next) {
        return;
      }
      const stamped = yield* stampUpdatedAt(next);
      const merged = yield* Ref.modify(input.store, (current) => {
        const updated = mergeRateLimits(current, stamped);
        return [updated, updated] as const;
      });
      const snapshot = yield* input.getSnapshot;
      yield* input.publishSnapshot({ ...snapshot, rateLimits: merged });
    }),
  );
});
