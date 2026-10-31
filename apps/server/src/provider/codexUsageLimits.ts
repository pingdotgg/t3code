import type {
  ProviderConsumeResetCreditOutcome,
  ProviderUsageLimitsUpdate,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as CodexErrors from "effect-codex-app-server/errors";

import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

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
    readonly id: string;
    readonly grantedAt?: number;
    readonly status: string;
    readonly expiresAt?: number | null;
  }> | null;
}

export function canAutoRedeemCodexReset(input: {
  readonly mode: "first" | "replay";
  readonly initialFingerprint: string;
  readonly freshFingerprint: string | undefined;
  readonly checkedBefore: string | undefined;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly creditsAvailable: number;
  readonly usageExhausted: boolean;
}) {
  return (
    input.freshFingerprint === input.initialFingerprint &&
    input.checkedBefore !== undefined &&
    input.limits !== undefined &&
    input.limits.unavailable === undefined &&
    input.limits.checkedAt !== undefined &&
    Date.parse(input.limits.checkedAt) > Date.parse(input.checkedBefore) &&
    (input.mode === "replay" || (input.creditsAvailable > 0 && input.usageExhausted))
  );
}

export function confirmsCodexResetCredit(input: {
  readonly initialFingerprint: string;
  readonly freshFingerprint: string | undefined;
  readonly outcome: ProviderConsumeResetCreditOutcome;
  readonly checkedBefore: string | undefined;
  readonly checkedAt: string | undefined;
  readonly limitsUnavailable: boolean;
  readonly usageExhausted: boolean;
}) {
  return (
    input.freshFingerprint === input.initialFingerprint &&
    (input.outcome === "reset" || input.outcome === "alreadyRedeemed") &&
    input.checkedBefore !== undefined &&
    input.checkedAt !== undefined &&
    Date.parse(input.checkedAt) > Date.parse(input.checkedBefore) &&
    !input.limitsUnavailable &&
    !input.usageExhausted
  );
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

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
  const available = (summary.credits ?? []).filter((credit) => credit.status === "available");
  const expiries = available
    .map((credit) => credit.expiresAt)
    .filter((value): value is number => typeof value === "number");
  const nextExpiresAt =
    expiries.length > 0 ? isoFromEpochSeconds(Math.min(...expiries)) : undefined;
  const nextCredit = available[0];
  return {
    availableCount: Math.max(0, summary.availableCount),
    ...(nextCredit?.id ? { nextCreditId: nextCredit.id } : {}),
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
  readonly credentialFingerprint?: string | undefined;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const resetCredits = codexResetCreditsToContract(input.resetCredits);
  const windows = codexRateLimitsToWindows(input.rateLimitsByLimitId?.codex ?? input.snapshot);
  return {
    ...makeUsageLimits({
      checkedAt: input.checkedAt,
      windows,
    }),
    ...(input.credentialFingerprint ? { credentialFingerprint: input.credentialFingerprint } : {}),
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

export function codexRateLimitsFailureMessage(error: CodexErrors.CodexAppServerError): string {
  switch (error._tag) {
    case "CodexAppServerRequestError":
      return `Codex could not read usage (JSON-RPC ${error.code}).`;
    case "CodexAppServerSpawnError":
      return "Codex could not be started to read usage.";
    case "CodexAppServerProcessExitedError":
      return "Codex exited before it could report usage.";
    default:
      return "Codex did not answer the usage request.";
  }
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
