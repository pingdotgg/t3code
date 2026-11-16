import type {
  ProviderUsageLimitsUpdate,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { clampPercent, makeUsageLimits } from "./usageLimits.ts";

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
  readonly individualLimit?: {
    readonly remainingPercent: number;
    readonly resetsAt: number;
  } | null;
}

export interface CodexResetCreditsSummary {
  readonly availableCount: number;
  readonly credits?: ReadonlyArray<{
    readonly status: string;
    readonly expiresAt?: number | null;
  }> | null;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 200 Subscription";
    case "prolite":
      return "ChatGPT Pro 100 Subscription";
    case "promax":
      return "ChatGPT Pro 500 Subscription";
    case "self_serve_business_prolite":
      return "ChatGPT Business Premium 5x Subscription";
    case "team":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function kindForDuration(mins: number): ServerProviderUsageWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function labelForKind(kind: ServerProviderUsageWindow["kind"]): string {
  return kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly";
}

/** primary/secondary are positions; without windowDurationMins, paid plans use 5-hour/weekly windows and Free/Go use monthly. */
function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<ServerProviderUsageWindow> {
  // Keep model-specific limits out of main allowance rows; older CLIs omit limit IDs.
  if (snapshot.limitId && snapshot.limitId !== "codex") return [];
  const isMonthlyPlan = snapshot.planType === "free" || snapshot.planType === "go";
  const positions = [
    ["primary", snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const windowDurationMins =
      typeof window.windowDurationMins === "number" ? window.windowDurationMins : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.resetsAt);
    windows.push({
      id,
      kind,
      label: labelForKind(kind),
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const individualLimit = snapshot.individualLimit;
  if (individualLimit && Number.isFinite(individualLimit.remainingPercent)) {
    const resetsAt = isoFromEpochSeconds(individualLimit.resetsAt);
    windows.push({
      id: "individual",
      kind: "monthly",
      label: "Monthly credit limit",
      usedPercent: clampPercent(100 - individualLimit.remainingPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

function codexResetCreditsToContract(
  summary: CodexResetCreditsSummary | null | undefined,
): ServerProviderResetCredits | undefined {
  if (!summary) return undefined;
  const expiries = (summary.credits ?? [])
    .filter((credit) => credit.status === "available")
    .map((credit) => credit.expiresAt)
    .filter((value): value is number => typeof value === "number");
  const nextExpiresAt =
    expiries.length > 0 ? isoFromEpochSeconds(Math.min(...expiries)) : undefined;
  return {
    availableCount: Math.max(0, summary.availableCount),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  };
}

export function codexRateLimitsToLimits(input: {
  readonly snapshot: CodexRateLimitSnapshot;
  readonly rateLimitsByLimitId?:
    | Readonly<Record<string, CodexRateLimitSnapshot>>
    | null
    | undefined;
  readonly resetCredits?: CodexResetCreditsSummary | null | undefined;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const resetCredits = codexResetCreditsToContract(input.resetCredits);
  const windows = codexRateLimitsToWindows(input.rateLimitsByLimitId?.codex ?? input.snapshot);
  return {
    ...makeUsageLimits({
      checkedAt: input.checkedAt,
      windows,
    }),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

export function codexRateLimitsToUpdate(
  snapshot: CodexRateLimitSnapshot,
  previous?: CodexRateLimitSnapshot,
): ProviderUsageLimitsUpdate | undefined {
  const previousWindows = previous ? codexRateLimitsToWindows(previous) : [];
  // Token ticks repeat session-cached limits that may predate an account probe or reset.
  const windows = codexRateLimitsToWindows(snapshot).filter((window) => {
    const existing = previousWindows.find((candidate) => candidate.id === window.id);
    return (
      !existing ||
      existing.kind !== window.kind ||
      existing.usedPercent !== window.usedPercent ||
      existing.resetsAt !== window.resetsAt ||
      existing.windowDurationMins !== window.windowDurationMins
    );
  });
  return windows.length > 0 ? { windows } : undefined;
}

/** Rate-limit notifications are partial: omitted fields preserve earlier session values. */
export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot | undefined {
  // Model-specific snapshots must not overwrite the main allowance.
  if (update.limitId && update.limitId !== "codex") return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: update.rateLimitReachedType }
      : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
    ...(update.individualLimit !== undefined ? { individualLimit: update.individualLimit } : {}),
  };
}

/** All exhausted windows must reset before a continuation can run. */
export function codexUsageLimitResetAt(
  snapshot: CodexRateLimitSnapshot | undefined,
): string | null {
  if (!snapshot) return null;
  const windows = codexRateLimitsToWindows(snapshot).filter((window) => window.usedPercent >= 100);
  if (windows.length === 0 || windows.some((window) => !window.resetsAt)) return null;
  return windows.reduce<string | null>(
    (latest, window) =>
      latest === null || Date.parse(window.resetsAt!) > Date.parse(latest)
        ? window.resetsAt!
        : latest,
    null,
  );
}

const CODEX_RESET_TEXT =
  /[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)\./;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The zone Codex prints reset times in: its own `TZ`, else the server's. */
export function codexTimeZone(
  environment: Readonly<Record<string, string | undefined>>,
): DateTime.TimeZone {
  return Option.getOrElse(
    DateTime.zoneMakeNamed(environment.TZ?.replace(/^:/, "") ?? ""),
    DateTime.zoneMakeLocal,
  );
}

// Proxies can strip snapshots, leaving only Codex's local reset time; use the failure's date.
export function codexMessageResetAt(
  message: string,
  failedAt: DateTime.DateTime,
  zone: DateTime.TimeZone,
): string | null {
  const match = CODEX_RESET_TEXT.exec(message);
  if (!match) return null;
  const [, month, day, year, hour, minute, meridiem] = match;
  const monthIndex = month === undefined ? undefined : MONTHS.indexOf(month);
  if (monthIndex === -1) return null;
  const today = DateTime.toParts(DateTime.setZone(failedAt, zone));
  const reset = DateTime.makeZoned(
    {
      year: monthIndex === undefined ? today.year : Number(year),
      month: monthIndex === undefined ? today.month : monthIndex + 1,
      day: monthIndex === undefined ? today.day : Number(day),
      hour: (Number(hour) % 12) + (meridiem === "PM" ? 12 : 0),
      minute: Number(minute),
    },
    // A repeated DST hour takes the later instant so a resume never fires early.
    { timeZone: zone, adjustForTimeZone: true, disambiguation: "later" },
  );
  if (Option.isNone(reset)) return null;
  // Codex drops the seconds, so the next minute is the first one past the reset.
  const resetAt = DateTime.add(reset.value, { minutes: 1 });
  return DateTime.isGreaterThan(resetAt, failedAt) ? DateTime.formatIso(resetAt) : null;
}

const CodexUsageWindow = Schema.Struct({
  used_percent: Schema.Finite,
  reset_at: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  limit_window_seconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export const CodexUsage = Schema.Struct({
  plan_type: Schema.optionalKey(Schema.String),
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optionalKey(Schema.NullOr(CodexUsageWindow)),
      secondary_window: Schema.optionalKey(Schema.NullOr(CodexUsageWindow)),
    }),
  ),
});

export function codexUsageToLimits(input: {
  readonly usage: typeof CodexUsage.Type;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const window = (
    value: typeof CodexUsageWindow.Type | null | undefined,
  ): CodexRateLimitWindow | null =>
    value
      ? {
          usedPercent: value.used_percent,
          resetsAt: value.reset_at ?? null,
          ...(value.limit_window_seconds === undefined
            ? {}
            : { windowDurationMins: Math.ceil(value.limit_window_seconds / 60) }),
        }
      : null;
  return codexRateLimitsToLimits({
    checkedAt: input.checkedAt,
    snapshot: {
      planType: input.usage.plan_type ?? null,
      primary: window(input.usage.rate_limit?.primary_window),
      secondary: window(input.usage.rate_limit?.secondary_window),
    },
  });
}
