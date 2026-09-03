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
  readonly planType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
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
export function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<ServerProviderUsageWindow> {
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

export function codexRateLimitsToLimits(input: {
  readonly snapshot: CodexRateLimitSnapshot;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  return makeUsageLimits({
    checkedAt: input.checkedAt,
    windows: codexRateLimitsToWindows(input.snapshot),
  });
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
