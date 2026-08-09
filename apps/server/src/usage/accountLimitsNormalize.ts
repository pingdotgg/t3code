/**
 * Normalizers for provider rate-limit payloads.
 *
 * Both adapters emit `account.rate-limits.updated` runtime events whose
 * payload is whatever the provider produced:
 *
 * - Claude, full set: the SDK usage control response
 *   (`{ subscription_type, rate_limits: { five_hour, seven_day, ... } }`).
 * - Claude, single window: the streamed `rate_limit_event` SDK message
 *   (`{ rate_limit_info: { rateLimitType, utilization, resetsAt } }`), which
 *   only ever names the window that is currently binding.
 * - Codex, live: the `account/rateLimits/updated` app-server notification
 *   (`{ rateLimits: { limitId, primary, secondary, planType, ... } }`,
 *   camelCase).
 * - Codex, transcript: the `rate_limits` object Codex writes beside every
 *   `token_count` line in its session files (same snapshot, snake_case).
 *
 * Everything folds into the `AccountLimitsWindow` contract shape here so the
 * service and clients never see a provider-specific field name.
 *
 * @module accountLimitsNormalize
 */
import type { AccountLimitsWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoFromUnixSeconds(value: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(value * 1000));
}

/**
 * Window ordering for display: the short window first, then the weekly, then
 * scoped windows.
 */
export function sortWindows(windows: readonly AccountLimitsWindow[]): AccountLimitsWindow[] {
  const rank = (window: AccountLimitsWindow): number =>
    window.id === "five_hour" ? 0 : window.id === "seven_day" ? 1 : 2;
  return [...windows].sort(
    (a, b) => rank(a) - rank(b) || (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/**
 * Windows we receive but deliberately do not surface: the oauth-apps bucket
 * and the opus/sonnet scoped weeklies are noise next to the three windows
 * users actually plan around (5h, weekly, Fable). `extra_usage` and `overage`
 * are credit meters, not windows.
 */
const CLAUDE_HIDDEN_WINDOW_KEYS = new Set([
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
  "extra_usage",
  "overage",
]);

interface ClaudeWindowMeta {
  readonly id: string;
  readonly label: string;
  readonly minutes: number | null;
}

/**
 * Maps a Claude window key to its display identity, or null for hidden keys.
 *
 * Unrecognised keys still become windows (with a humanized label) so a window
 * Anthropic adds or renames shows up without a code change. The Fable weekly
 * has already lived under more than one name, so anything fable-ish is
 * normalised onto one id.
 */
function claudeWindowMeta(key: string): ClaudeWindowMeta | null {
  if (CLAUDE_HIDDEN_WINDOW_KEYS.has(key)) return null;
  if (key === "five_hour") return { id: "five_hour", label: "5h", minutes: FIVE_HOUR_MINUTES };
  if (key === "seven_day") return { id: "seven_day", label: "Week", minutes: SEVEN_DAY_MINUTES };
  if (key === "iguana_necktie" || key.toLowerCase().includes("fable")) {
    return { id: "fable", label: "Fable", minutes: SEVEN_DAY_MINUTES };
  }
  const stripped = key.startsWith("seven_day_") ? key.slice("seven_day_".length) : key;
  const label = stripped.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return {
    id: key,
    label,
    minutes: key.startsWith("seven_day") ? SEVEN_DAY_MINUTES : null,
  };
}

function claudeWindowFromEntry(meta: ClaudeWindowMeta, entry: unknown): AccountLimitsWindow | null {
  if (!isRecord(entry)) return null;
  if (!("utilization" in entry) && !("resets_at" in entry)) return null;
  const utilization = readNumber(entry.utilization);
  return {
    id: meta.id,
    label: meta.label,
    // A null utilization is an untouched window, which is 0% used.
    usedPercent: utilization === null ? 0 : clampPercent(utilization),
    resetsAt: readString(entry.resets_at),
    windowMinutes: meta.minutes,
  };
}

export interface ClaudeUsageSnapshot {
  readonly plan: string | null;
  readonly windows: AccountLimitsWindow[];
}

/**
 * Parses the SDK usage control response. Returns null when the value is not
 * that shape (so the caller can try the single-event shape instead), and an
 * empty window list when rate limits do not apply (API key, Bedrock, Vertex).
 */
export function claudeUsageSnapshotFromUnknown(value: unknown): ClaudeUsageSnapshot | null {
  if (!isRecord(value)) return null;
  const rateLimits = value.rate_limits;
  if (rateLimits === null) return { plan: readString(value.subscription_type), windows: [] };
  if (!isRecord(rateLimits)) return null;

  const windows = new Map<string, AccountLimitsWindow>();
  for (const [key, entry] of Object.entries(rateLimits)) {
    if (key === "limits") continue;
    const meta = claudeWindowMeta(key);
    if (!meta) continue;
    const window = claudeWindowFromEntry(meta, entry);
    if (window) windows.set(window.id, window);
  }

  // Newer payloads replace the flat keys with a self-describing `limits`
  // array. Read both; array entries win because the flat keys go null first.
  const limits = rateLimits.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const window = claudeWindowFromLimitEntry(entry);
      if (window) windows.set(window.id, window);
    }
  }

  return { plan: readString(value.subscription_type), windows: sortWindows([...windows.values()]) };
}

/** One entry of the newer `rate_limits.limits` array. */
function claudeWindowFromLimitEntry(entry: unknown): AccountLimitsWindow | null {
  if (!isRecord(entry)) return null;
  const percent = readNumber(entry.percent);
  const resetsAt = readString(entry.resets_at);
  const kind = readString(entry.kind);
  if (kind === "session") {
    return {
      id: "five_hour",
      label: "5h",
      usedPercent: percent === null ? 0 : clampPercent(percent),
      resetsAt,
      windowMinutes: FIVE_HOUR_MINUTES,
    };
  }
  if (kind === "weekly_all") {
    return {
      id: "seven_day",
      label: "Week",
      usedPercent: percent === null ? 0 : clampPercent(percent),
      resetsAt,
      windowMinutes: SEVEN_DAY_MINUTES,
    };
  }
  if (kind === "weekly_scoped") {
    const scope = isRecord(entry.scope) ? entry.scope : null;
    const model = scope && isRecord(scope.model) ? scope.model : null;
    const name = (model && (readString(model.display_name) ?? readString(model.id))) ?? null;
    if (name === null) return null;
    // Same visibility call as the flat keys: Fable is its own limit worth
    // showing, the opus/sonnet scoped weeklies are hidden.
    if (/opus|sonnet/i.test(name)) return null;
    const isFable = /fable/i.test(name);
    return {
      id: isFable ? "fable" : `scoped_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      label: isFable ? "Fable" : name,
      usedPercent: percent === null ? 0 : clampPercent(percent),
      resetsAt,
      windowMinutes: SEVEN_DAY_MINUTES,
    };
  }
  return null;
}

/**
 * Parses the streamed `rate_limit_event` SDK message into the one window it
 * names. Returns null for shapes that are not that message, and for windows
 * we hide.
 */
export function claudeWindowFromRateLimitEvent(value: unknown): AccountLimitsWindow | null {
  if (!isRecord(value)) return null;
  const info = value.rate_limit_info;
  if (!isRecord(info)) return null;
  const type = readString(info.rateLimitType);
  if (type === null) return null;
  const meta = claudeWindowMeta(type);
  if (!meta) return null;
  const utilization = readNumber(info.utilization);
  const resetsAt = readNumber(info.resetsAt);
  return {
    id: meta.id,
    label: meta.label,
    usedPercent: utilization === null ? 0 : clampPercent(utilization),
    resetsAt: resetsAt === null ? null : isoFromUnixSeconds(resetsAt),
    windowMinutes: meta.minutes,
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export interface CodexRateLimitsSnapshot {
  readonly limitId: string | null;
  readonly plan: string | null;
  readonly windows: AccountLimitsWindow[];
}

/**
 * The main Codex meter. Other limit ids are per-model side meters (Spark ships
 * as `codex_bengalfox` / "GPT-5.3-Codex-Spark") that we do not surface.
 */
export function isPrimaryCodexLimit(limitId: string | null): boolean {
  return limitId === null || limitId === "codex";
}

/**
 * Parses a Codex rate-limit snapshot, live (camelCase) or transcript
 * (snake_case). The live notification nests the snapshot under `rateLimits`.
 */
export function codexSnapshotFromUnknown(value: unknown): CodexRateLimitsSnapshot | null {
  if (!isRecord(value)) return null;
  const snapshot = isRecord(value.rateLimits) ? value.rateLimits : value;
  const limitId = readString(snapshot.limitId ?? snapshot.limit_id);
  const plan = readString(snapshot.planType ?? snapshot.plan_type);

  const windows: AccountLimitsWindow[] = [];
  const primary = codexWindowFromSlot(snapshot.primary, "primary");
  if (primary) windows.push(primary);
  const secondary = codexWindowFromSlot(snapshot.secondary, "secondary");
  if (secondary && !windows.some((window) => window.id === secondary.id)) {
    windows.push(secondary);
  }
  if (windows.length === 0 && limitId === null && plan === null) return null;

  return { limitId, plan, windows: sortWindows(windows) };
}

/**
 * Classifies a Codex window by its duration, not its slot: OpenAI currently
 * ships the weekly window in `primary` with `secondary` empty (the 5-hour
 * window is paused), and will presumably shuffle slots again when it returns.
 * Slot order is only the fallback for legacy payloads with no duration.
 */
function codexWindowFromSlot(
  value: unknown,
  slot: "primary" | "secondary",
): AccountLimitsWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = readNumber(value.usedPercent ?? value.used_percent);
  if (usedPercent === null) return null;
  const minutes = readNumber(value.windowDurationMins ?? value.window_minutes);
  const resetsAtSeconds = readNumber(value.resetsAt ?? value.resets_at);
  const resetsAt = resetsAtSeconds === null ? null : isoFromUnixSeconds(resetsAtSeconds);

  const effectiveMinutes = minutes ?? (slot === "primary" ? FIVE_HOUR_MINUTES : SEVEN_DAY_MINUTES);
  if (effectiveMinutes === FIVE_HOUR_MINUTES) {
    return {
      id: "five_hour",
      label: "5h",
      usedPercent: clampPercent(usedPercent),
      resetsAt,
      windowMinutes: FIVE_HOUR_MINUTES,
    };
  }
  if (effectiveMinutes === SEVEN_DAY_MINUTES) {
    return {
      id: "seven_day",
      label: "Week",
      usedPercent: clampPercent(usedPercent),
      resetsAt,
      windowMinutes: SEVEN_DAY_MINUTES,
    };
  }
  return {
    id: `window_${effectiveMinutes}m`,
    label:
      effectiveMinutes % (24 * 60) === 0
        ? `${effectiveMinutes / (24 * 60)}d`
        : `${Math.max(1, Math.round(effectiveMinutes / 60))}h`,
    usedPercent: clampPercent(usedPercent),
    resetsAt,
    windowMinutes: effectiveMinutes,
  };
}
