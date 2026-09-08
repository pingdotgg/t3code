/**
 * Codex subscription usage. The `account/rateLimits/read` response and the
 * `account/rateLimits/updated` notification carry the same snapshot shape, so
 * one mapper serves the status probe and the turn-driven update; both emit
 * windows with the same ids so they merge onto the same rows.
 *
 * @module provider/Layers/codexUsageLimits
 */
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as CodexErrors from "effect-codex-app-server/errors";

import { clampPercent, makeUsageLimits } from "../providerUsageLimits.ts";

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

/** Structural view of the generated `RateLimitSnapshot`; both messages satisfy it. */
export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

/** Structural view of the read response's `rateLimitResetCredits`. */
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

/**
 * `primary` / `secondary` are positions, not durations. Codex usually sends
 * `windowDurationMins`; when it does not, paid plans expose the 5-hour and
 * weekly pair and Free/Go expose one monthly allowance.
 */
function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<ServerProviderUsageWindow> {
  // Show the main allowance only. Model-specific notifications (such as Spark)
  // must not replace its primary/secondary rows. Older CLIs omit the limit id.
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
  return windows;
}

export function codexResetCreditsToContract(
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
  // Select the main bucket explicitly; the legacy snapshot can name another limit.
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
): ProviderUsageLimitsUpdate | undefined {
  const windows = codexRateLimitsToWindows(snapshot);
  return windows.length > 0 ? { windows } : undefined;
}

/**
 * A bounded, client-safe reason for a failed `account/rateLimits/read`. The
 * raw error is for the log; only the category and, for a JSON-RPC failure,
 * the code reach the Limits view.
 */
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

/**
 * Codex sends `account/rateLimits/updated` as a partial view of the snapshot: a
 * field the update omits keeps the value observed earlier in the session, so a
 * later notification that only names the limit it reached must not drop the
 * windows an earlier one carried.
 */
export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot | undefined {
  // Model-specific snapshots (such as Spark) describe a different allowance
  // and must not overwrite the main one, the same rule the usage rows apply.
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
  };
}

/** Coarse remaining wait, matching how the usage rows read: `5d 5h`, `3h 20m`, `12m`. */
function formatCodexUsageLimitWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function codexUsageLimitNextStep(rateLimitReachedType: string | null | undefined): string {
  switch (rateLimitReachedType) {
    case "workspace_owner_credits_depleted":
    case "workspace_member_credits_depleted":
      return " The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.";
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return " The workspace spend limit is reached: ask your workspace owner to raise it, or send the message again once the limit resets.";
    default:
      return " Send the message again once the limit resets.";
  }
}

/**
 * The message a usage-limit stop shows instead of the provider sentence, which
 * on a Business workspace blames credits for a window that simply ran out. The
 * window named is the exhausted one that has yet to reset, latest first; `atIso`
 * is the stopping event's timestamp, not the wall clock.
 */
export function codexUsageLimitMessage(
  snapshot: CodexRateLimitSnapshot | undefined,
  atIso: string,
): string {
  const atMs = Date.parse(atIso);
  const windows = snapshot && Number.isFinite(atMs) ? codexRateLimitsToWindows(snapshot) : [];
  let reset = "";
  let latestResetMs = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    if (window.usedPercent < 100 || !window.resetsAt) continue;
    const resetMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetMs) || resetMs <= atMs || resetMs <= latestResetMs) continue;
    latestResetMs = resetMs;
    reset = ` The ${window.kind} limit resets in ${formatCodexUsageLimitWait(resetMs - atMs)}.`;
  }
  return `Codex usage limit reached.${reset}${codexUsageLimitNextStep(snapshot?.rateLimitReachedType)}`;
}
