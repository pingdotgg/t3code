/**
 * Normalize provider-native usage-limit notifications into
 * `ServerProviderRateLimit`. Each adapter forwards its runtime's payload
 * untouched on `account.rate-limits.updated`; this is the one place that knows
 * the per-driver shapes.
 *
 * @module provider/providerRateLimits
 */
import type { ServerProviderRateLimit, ServerProviderRateLimitStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const USAGE_LIMIT_ERROR_PATTERN =
  /hit your (usage )?limit|usage limit|rate[ -]?limit|limit reached|too many requests|resets? (at|in) /i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Providers report reset times as unix seconds; a few already use millis. */
function epochToIso(value: unknown): string | undefined {
  const epoch = asFiniteNumber(value);
  if (epoch === undefined || epoch <= 0) return undefined;
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const dateTime = DateTime.make(ms);
  return Option.isNone(dateTime) ? undefined : DateTime.formatIso(dateTime.value);
}

function clampUtilization(value: unknown): number | undefined {
  const utilization = asFiniteNumber(value);
  if (utilization === undefined) return undefined;
  return Math.min(100, Math.max(0, utilization));
}

function build(input: {
  readonly status: ServerProviderRateLimitStatus;
  readonly resetsAt?: string | undefined;
  readonly window?: string | undefined;
  readonly utilization?: number | undefined;
  readonly observedAt: string;
}): ServerProviderRateLimit {
  return {
    status: input.status,
    ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
    ...(input.window !== undefined ? { window: input.window } : {}),
    ...(input.utilization !== undefined ? { utilization: input.utilization } : {}),
    observedAt: input.observedAt,
  };
}

/**
 * Claude Agent SDK `rate_limit_event`:
 * `{ rate_limit_info: { status, resetsAt, rateLimitType, utilization } }`.
 */
function readClaudeRateLimit(
  payload: Record<string, unknown>,
  observedAt: string,
): ServerProviderRateLimit | undefined {
  const info = asRecord(payload.rate_limit_info);
  if (!info) return undefined;
  const status =
    info.status === "rejected"
      ? "rejected"
      : info.status === "allowed_warning"
        ? "warning"
        : info.status === "allowed"
          ? "allowed"
          : undefined;
  if (status === undefined) return undefined;
  return build({
    status,
    resetsAt: epochToIso(info.resetsAt),
    window: asNonEmptyString(info.rateLimitType),
    utilization: clampUtilization(info.utilization),
    observedAt,
  });
}

/**
 * Codex app-server `account/rateLimits/updated`:
 * `{ rateLimits: { primary?, secondary?, rateLimitReachedType? } }` where each
 * window is `{ usedPercent, resetsAt, windowDurationMins }`.
 */
function readCodexRateLimit(
  payload: Record<string, unknown>,
  observedAt: string,
): ServerProviderRateLimit | undefined {
  const snapshot = asRecord(payload.rateLimits) ?? payload;
  const windows = [asRecord(snapshot.primary), asRecord(snapshot.secondary)].filter(
    (window): window is Record<string, unknown> => window !== undefined,
  );
  if (windows.length === 0 && snapshot.rateLimitReachedType === undefined) return undefined;

  const hottest = windows.reduce<Record<string, unknown> | undefined>((best, window) => {
    const used = asFiniteNumber(window.usedPercent) ?? 0;
    const bestUsed = best ? (asFiniteNumber(best.usedPercent) ?? 0) : -1;
    return used > bestUsed ? window : best;
  }, undefined);
  const utilization = hottest ? clampUtilization(hottest.usedPercent) : undefined;
  const reached = asNonEmptyString(snapshot.rateLimitReachedType) !== undefined;
  const status: ServerProviderRateLimitStatus =
    reached || (utilization !== undefined && utilization >= 100)
      ? "rejected"
      : utilization !== undefined && utilization >= 90
        ? "warning"
        : "allowed";
  const windowMinutes = hottest ? asFiniteNumber(hottest.windowDurationMins) : undefined;
  return build({
    status,
    resetsAt: hottest ? epochToIso(hottest.resetsAt) : undefined,
    window: windowMinutes !== undefined ? `${windowMinutes}m` : undefined,
    utilization,
    observedAt,
  });
}

/**
 * Read a rate-limit snapshot out of an `account.rate-limits.updated` payload.
 * Returns `undefined` when the payload is not understood so callers leave the
 * previous state untouched.
 */
export function readProviderRateLimitFromPayload(input: {
  readonly driver: string;
  readonly payload: unknown;
  readonly observedAt: string;
}): ServerProviderRateLimit | undefined {
  const outer = asRecord(input.payload);
  const rateLimits = asRecord(outer?.rateLimits);
  if (!rateLimits) return undefined;
  switch (input.driver) {
    case "claudeAgent":
      return readClaudeRateLimit(rateLimits, input.observedAt);
    case "codex":
      return readCodexRateLimit(rateLimits, input.observedAt);
    default:
      return undefined;
  }
}

/** How long an error-text detection stays active without a structured update. */
export const TURN_ERROR_RATE_LIMIT_TTL_MS = 15 * 60 * 1000;

const TURN_ERROR_RATE_LIMIT_DRIVERS = new Set(["claudeAgent", "codex"]);

/**
 * Claude and Codex sometimes surface a usage limit only as the failing turn's
 * error text, ahead of or instead of a structured update. Treat that as a
 * short-lived rejection so the account is not retried blindly; a structured
 * update replaces it and the TTL clears it otherwise. Other drivers emit no
 * structured updates at all, so their error text is left alone rather than
 * marking the account limited indefinitely.
 */
export function readProviderRateLimitFromTurnError(input: {
  readonly driver: string;
  readonly errorMessage: string | undefined;
  readonly observedAt: string;
}): ServerProviderRateLimit | undefined {
  if (!TURN_ERROR_RATE_LIMIT_DRIVERS.has(input.driver)) return undefined;
  if (!input.errorMessage || !USAGE_LIMIT_ERROR_PATTERN.test(input.errorMessage)) {
    return undefined;
  }
  const observedMs = Date.parse(input.observedAt);
  const resetsAt = Number.isFinite(observedMs)
    ? epochToIso(observedMs + TURN_ERROR_RATE_LIMIT_TTL_MS)
    : undefined;
  return build({ status: "rejected", resetsAt, observedAt: input.observedAt });
}
