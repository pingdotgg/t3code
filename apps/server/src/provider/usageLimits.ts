/**
 * Normalizers that turn provider-shaped rate-limit payloads into the
 * provider-agnostic `ProviderUsageLimits` contract.
 *
 * Every provider reports quota differently — Claude's OAuth usage endpoint
 * nests per-model weekly limits inside a `limits[]` array, Codex hands back
 * `primary`/`secondary` windows with a duration in minutes. All of that mess
 * stops here so the registry, the wire, and the UI only ever see
 * `{ id, label, usedPercent, resetsAt }`.
 *
 * These functions are total: any input they cannot make sense of yields an
 * empty window list rather than an error. Usage meters are ambient, so a
 * malformed payload must degrade to "no circles", never to a failed turn.
 *
 * @module usageLimits
 */
import type { ProviderUsageLimits, ProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Coerce the many shapes a percentage arrives in, clamped to 0-100.
 *
 * Blank strings are rejected rather than coerced: `Number("")` is `0`, which
 * would draw a confident "0% used" meter for a field the provider left empty.
 */
const readPercent = (value: unknown): number | null => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, parsed));
};

/**
 * Reset times arrive as ISO strings, second-precision epochs, or
 * millisecond-precision epochs depending on provider and transport. The 1e12
 * threshold separates the two epoch flavours (1e12 ms is 2001; no plausible
 * reset time is that far in the past, and no plausible epoch-seconds value is
 * that large).
 */
const readIsoTimestamp = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value;
    return Option.match(DateTime.make(milliseconds), {
      onNone: () => null,
      onSome: DateTime.formatIso,
    });
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return readIsoTimestamp(asNumber);
  }
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
};

const makeWindow = (input: {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}): ProviderUsageWindow => input;

/**
 * Read one bucket out of the Claude usage payload. Claude names the same
 * concept `utilization` on some buckets and `used_percentage` on others, and
 * the reset key varies the same way.
 */
const readClaudeBucket = (
  value: unknown,
  window: { readonly id: string; readonly label: string },
): ProviderUsageWindow | null => {
  if (!isRecord(value)) {
    return null;
  }
  // Try each alias through the parser rather than `??`-chaining the raw
  // values: a present-but-malformed first alias must not mask a readable
  // later one.
  const usedPercent = [
    value.used_percentage,
    value.utilization,
    value.usedPercentage,
    value.percent,
  ].reduce<number | null>((found, candidate) => found ?? readPercent(candidate), null);
  if (usedPercent === null) {
    return null;
  }
  return makeWindow({
    id: window.id,
    label: window.label,
    usedPercent,
    resetsAt: [value.resets_at, value.resetsAt, value.reset_at, value.resetAt].reduce<
      string | null
    >((found, candidate) => found ?? readIsoTimestamp(candidate), null),
  });
};

/**
 * Fable is not a top-level bucket. It is reported as a model-scoped weekly
 * entry inside `limits[]`, matched on the model's display name. The legacy
 * top-level `seven_day_<model>` keys read null on current plans, so this is
 * the only place the number exists.
 */
const findScopedWeeklyLimit = (payload: Record<string, unknown>, pattern: RegExp): unknown => {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  return (
    limits.find((limit) => {
      if (!isRecord(limit) || limit.group !== "weekly") {
        return false;
      }
      const scope = isRecord(limit.scope) ? limit.scope : undefined;
      const model = scope && isRecord(scope.model) ? scope.model : undefined;
      const displayName = model?.display_name;
      return typeof displayName === "string" && pattern.test(displayName);
    }) ?? null
  );
};

/**
 * Normalize the OAuth usage endpoint's response. This is the only Claude
 * source that reports every bucket at once, and therefore the only one that
 * can populate Fable — the Agent SDK's turn events carry a single bucket and
 * have no Fable bucket type at all (see `normalizeClaudeRateLimitEvent`).
 *
 * The response has no envelope, so read the top level directly. Unwrapping a
 * speculative one risks descending past the buckets if the payload ever
 * grows an unrelated `usage` key.
 */
export const normalizeClaudeUsage = (
  raw: unknown,
  updatedAt: string,
): ProviderUsageLimits | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const payload = raw;

  const windows: Array<ProviderUsageWindow> = [];
  const session = readClaudeBucket(payload.five_hour ?? payload.fiveHour ?? payload.session, {
    id: "session",
    label: "Session",
  });
  if (session) {
    windows.push(session);
  }
  const weekly = readClaudeBucket(payload.seven_day ?? payload.sevenDay ?? payload.weekly, {
    id: "weekly",
    label: "Weekly",
  });
  if (weekly) {
    windows.push(weekly);
  }
  const fable = readClaudeBucket(findScopedWeeklyLimit(payload, /fable/i), {
    id: "weekly-fable",
    label: "Fable",
  });
  if (fable) {
    windows.push(fable);
  }

  if (windows.length === 0) {
    return null;
  }
  return { windows, updatedAt };
};

/**
 * Which window each `SDKRateLimitInfo.rateLimitType` describes.
 *
 * `overage` is deliberately absent: it is a spend state, not a quota window,
 * and has no meter. Note there is no Fable bucket type — the SDK cannot
 * report it, so the Fable circle only ever populates from the OAuth pull.
 */
const CLAUDE_SDK_WINDOW_BY_RATE_LIMIT_TYPE: Readonly<
  Record<string, { readonly id: string; readonly label: string }>
> = {
  five_hour: { id: "session", label: "Session" },
  seven_day: { id: "weekly", label: "Weekly" },
  seven_day_opus: { id: "weekly-opus", label: "Opus" },
  seven_day_sonnet: { id: "weekly-sonnet", label: "Sonnet" },
};

/**
 * Normalize the Agent SDK's `rate_limit_event`, which the Claude adapter
 * forwards verbatim as `payload.rateLimits`.
 *
 * The shape is flat and describes exactly one bucket:
 * `{ rate_limit_info: { rateLimitType, utilization, resetsAt } }`. That is
 * why readings from this feed must be merged into the stored set rather than
 * replacing it — a `five_hour` event says nothing about the weekly window,
 * and treating it as a full reading would blank the other meters.
 */
export const normalizeClaudeRateLimitEvent = (
  raw: unknown,
  updatedAt: string,
): ProviderUsageLimits | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const info = isRecord(raw.rate_limit_info) ? raw.rate_limit_info : null;
  if (info === null) {
    return null;
  }
  const rateLimitType = info.rateLimitType;
  if (typeof rateLimitType !== "string") {
    return null;
  }
  const window = CLAUDE_SDK_WINDOW_BY_RATE_LIMIT_TYPE[rateLimitType];
  if (window === undefined) {
    return null;
  }
  // `utilization` is a 0-100 percentage, matching the OAuth endpoint's
  // `used_percentage` for the same buckets.
  const usedPercent = readPercent(info.utilization);
  if (usedPercent === null) {
    return null;
  }
  return {
    windows: [
      makeWindow({
        id: window.id,
        label: window.label,
        usedPercent,
        resetsAt: readIsoTimestamp(info.resetsAt),
      }),
    ],
    updatedAt,
  };
};

/**
 * Codex labels come from the window's own duration rather than from which
 * slot it arrived in, because the slots are not guaranteed to mean
 * session/weekly across plan types. A missing duration falls back to slot
 * order. The `id` stays slot-derived so identity survives a label change.
 */
const codexWindowLabel = (
  durationMinutes: unknown,
  fallback: "Session" | "Weekly",
): "Session" | "Weekly" => {
  const minutes = typeof durationMinutes === "number" ? durationMinutes : Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fallback;
  }
  return minutes < 24 * 60 ? "Session" : "Weekly";
};

const readCodexWindow = (
  value: unknown,
  slot: { readonly id: string; readonly fallbackLabel: "Session" | "Weekly" },
): ProviderUsageWindow | null => {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = readPercent(value.usedPercent ?? value.used_percent);
  if (usedPercent === null) {
    return null;
  }
  return makeWindow({
    id: slot.id,
    label: codexWindowLabel(
      value.windowDurationMins ?? value.window_duration_mins,
      slot.fallbackLabel,
    ),
    usedPercent,
    resetsAt: readIsoTimestamp(value.resetsAt ?? value.resets_at),
  });
};

/**
 * Normalize `account/rateLimits/read` responses and
 * `account/rateLimits/updated` notifications — both wrap the snapshot in a
 * `rateLimits` key.
 */
export const normalizeCodexUsage = (
  raw: unknown,
  updatedAt: string,
): ProviderUsageLimits | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const snapshot = isRecord(raw.rateLimits) ? raw.rateLimits : raw;

  const windows: Array<ProviderUsageWindow> = [];
  const primary = readCodexWindow(snapshot.primary, {
    id: "codex-primary",
    fallbackLabel: "Session",
  });
  if (primary) {
    windows.push(primary);
  }
  const secondary = readCodexWindow(snapshot.secondary, {
    id: "codex-secondary",
    fallbackLabel: "Weekly",
  });
  if (secondary) {
    windows.push(secondary);
  }

  if (windows.length === 0) {
    return null;
  }
  return { windows, updatedAt };
};

/**
 * How much of the picture a reading claims to describe.
 *
 * `full` — every window the account has, so windows the reading omits are
 * genuinely gone (a plan change, a bucket retired). Produced by Claude's
 * OAuth pull and Codex's `account/rateLimits/read`.
 *
 * `partial` — one or more windows, saying nothing about the rest. Produced
 * by Claude's per-bucket `rate_limit_event` and by Codex's explicitly sparse
 * `account/rateLimits/updated`. Applying one of these as if it were full
 * would blank every meter it happens not to mention.
 */
export type UsageReadingMode = "full" | "partial";

// An unparseable `updatedAt` sorts as the oldest possible reading, so a
// malformed stamp can never displace a good one.
const usageEpochMillis = (isoTimestamp: string): number =>
  Option.match(DateTime.make(isoTimestamp), {
    onNone: () => Number.NEGATIVE_INFINITY,
    onSome: DateTime.toEpochMillis,
  });

/**
 * Fold a new reading into the stored one.
 *
 * Several feeds write usage for the same instance and they land out of
 * order, so a stale reading never overwrites a fresher one. A `partial`
 * reading updates only the windows it names and leaves the rest standing;
 * a `full` one replaces the set outright.
 *
 * Window order follows the stored reading, with genuinely new windows
 * appended — the circles must not reshuffle in the composer when one bucket
 * happens to update on its own.
 */
export const applyUsageReading = (
  previous: ProviderUsageLimits | undefined,
  incoming: ProviderUsageLimits,
  mode: UsageReadingMode,
): ProviderUsageLimits => {
  if (previous === undefined) {
    return incoming;
  }
  const isStale = usageEpochMillis(incoming.updatedAt) < usageEpochMillis(previous.updatedAt);
  if (isStale) {
    return previous;
  }
  if (mode === "full") {
    return incoming;
  }

  const incomingById = new Map(incoming.windows.map((window) => [window.id, window] as const));
  const merged = previous.windows.map((window) => incomingById.get(window.id) ?? window);
  const known = new Set(previous.windows.map((window) => window.id));
  for (const window of incoming.windows) {
    if (!known.has(window.id)) {
      merged.push(window);
    }
  }
  return { windows: merged, updatedAt: incoming.updatedAt };
};
