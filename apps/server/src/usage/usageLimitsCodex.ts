/**
 * Pure parsing for Codex subscription limits.
 *
 * The auth kind comes from the Codex CLI's `auth.json` (a ChatGPT sign-in
 * carries OAuth tokens; API-key auth carries only the key), and the figures
 * come from the `codex app-server` RPC `account/rateLimits/read`. The mapper
 * takes the response as `unknown` and reads it defensively: the same window
 * shape arrives camelCased from the app server and the generated schema has
 * been stricter than the wire in the past (integer-only percents), so the
 * mapper must not depend on a successful decode.
 *
 * @module usageLimitsCodex
 */
import type { UsageLimitWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type CodexAuthKind = "chatgpt" | "apiKey" | "none";

/** Classifies the CLI's `auth.json` document. */
export function parseCodexAuthKind(raw: string): CodexAuthKind {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return "none";
  }
  if (typeof document !== "object" || document === null) return "none";
  const { auth_mode, OPENAI_API_KEY, tokens } = document as Record<string, unknown>;
  if (auth_mode === "chatgpt") return "chatgpt";
  if (typeof tokens === "object" && tokens !== null) {
    const { access_token } = tokens as Record<string, unknown>;
    if (typeof access_token === "string" && access_token.trim().length > 0) return "chatgpt";
  }
  if (typeof OPENAI_API_KEY === "string" && OPENAI_API_KEY.trim().length > 0) return "apiKey";
  return "none";
}

/**
 * Plan chip labels, mirroring the provider snapshot's auth labels but without
 * the "Subscription" suffix the compact chip has no room for.
 */
const PLAN_LABELS: Record<string, string> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro 20x",
  prolite: "ChatGPT Pro 5x",
  team: "ChatGPT Team",
  self_serve_business_usage_based: "ChatGPT Business",
  business: "ChatGPT Business",
  enterprise_cbp_usage_based: "ChatGPT Enterprise",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  unknown: "ChatGPT",
};

export function codexPlanLabel(planType: string | null): string | null {
  if (planType === null) return null;
  const normalized = planType.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return (
    PLAN_LABELS[normalized] ?? `ChatGPT ${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
  );
}

/** See {@link usageLimitsClaude}: clamped, not rounded. */
function clampUtilization(value: number): number {
  return Math.min(Math.max(value, 0), 999);
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Codex windows carry a duration instead of a name; title by cadence so a
 * 5-hour primary reads like Claude's session window and 10080 minutes reads
 * as weekly.
 */
function windowTitle(durationMins: number | null): { label: string; detail: string | null } {
  if (durationMins === null) return { label: "Rate limit", detail: null };
  if (durationMins < MINUTES_PER_DAY) {
    const hours = Math.max(1, Math.round(durationMins / 60));
    return { label: "Session limit", detail: `Rolling ${hours}-hour window` };
  }
  const days = Math.max(1, Math.round(durationMins / MINUTES_PER_DAY));
  if (days === 7) return { label: "Weekly limit", detail: "Rolling 7-day window" };
  return { label: `${days}-day limit`, detail: `Rolling ${days}-day window` };
}

interface RawWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: string | null;
}

/** One `primary`/`secondary` window object; unix seconds become ISO instants. */
function readWindow(value: unknown): RawWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const { usedPercent, windowDurationMins, resetsAt } = value as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  return {
    usedPercent,
    windowDurationMins:
      typeof windowDurationMins === "number" && Number.isFinite(windowDurationMins)
        ? windowDurationMins
        : null,
    resetsAt:
      typeof resetsAt === "number" && Number.isFinite(resetsAt)
        ? DateTime.formatIso(DateTime.makeUnsafe(resetsAt * 1000))
        : null,
  };
}

function snapshotWindows(limitId: string, snapshot: unknown): UsageLimitWindow[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const { primary, secondary, limitName } = snapshot as Record<string, unknown>;
  const name =
    typeof limitName === "string" && limitName.trim().length > 0 ? limitName.trim() : null;

  const windows: UsageLimitWindow[] = [];
  for (const [part, value] of [
    ["primary", primary],
    ["secondary", secondary],
  ] as const) {
    const window = readWindow(value);
    if (window === null) continue;
    const title = windowTitle(window.windowDurationMins);
    windows.push({
      id: `${limitId}:${part}`,
      label: name === null ? title.label : `${title.label} (${name})`,
      detail: title.detail,
      utilization: clampUtilization(window.usedPercent),
      resetsAt: window.resetsAt,
    });
  }
  return windows;
}

function snapshotPlanType(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const { planType } = snapshot as Record<string, unknown>;
  return typeof planType === "string" && planType.trim().length > 0 ? planType.trim() : null;
}

export interface CodexRateLimits {
  readonly windows: UsageLimitWindow[];
  readonly planType: string | null;
}

/**
 * Extracts rate windows from an `account/rateLimits/read` response.
 *
 * The multi-bucket `rateLimitsByLimitId` view is preferred: it is the only
 * place model-scoped buckets (with human `limitName`s) appear, and its
 * default bucket duplicates the legacy single-bucket `rateLimits` field.
 */
export function mapCodexRateLimits(response: unknown): CodexRateLimits {
  if (typeof response !== "object" || response === null) {
    return { windows: [], planType: null };
  }
  const { rateLimits, rateLimitsByLimitId } = response as Record<string, unknown>;

  const windows: UsageLimitWindow[] = [];
  let planType: string | null = null;

  if (typeof rateLimitsByLimitId === "object" && rateLimitsByLimitId !== null) {
    for (const [limitId, snapshot] of Object.entries(rateLimitsByLimitId)) {
      windows.push(...snapshotWindows(limitId, snapshot));
      planType ??= snapshotPlanType(snapshot);
    }
  }
  if (windows.length === 0) {
    windows.push(...snapshotWindows("codex", rateLimits));
  }
  planType ??= snapshotPlanType(rateLimits);

  return { windows, planType };
}
