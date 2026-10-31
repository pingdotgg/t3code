import type { LinearConnectionStatus } from "@t3tools/contracts";

/** Why the page is showing cached data (or none) instead of fresh Linear answers. */
export type LinearDegradation = "rate_limited" | "unavailable";

export type LinearFailureKind = LinearDegradation | "unauthorized" | "not_connected" | "other";

function reasonOf(failure: unknown): string | null {
  if (typeof failure !== "object" || failure === null) return null;
  const record = failure as { readonly _tag?: unknown; readonly reason?: unknown };
  return record._tag === "LinearError" && typeof record.reason === "string" ? record.reason : null;
}

export function classifyLinearFailure(failure: unknown): LinearFailureKind {
  const reason = reasonOf(failure);
  switch (reason) {
    case "rate_limited":
      return "rate_limited";
    case "unauthorized":
      return "unauthorized";
    case "not_connected":
      return "not_connected";
    case "unavailable":
      return "unavailable";
    case null:
      // Transport failures (environment unreachable) read as "Linear is down" to the reader.
      return failure === null || failure === undefined ? "other" : "unavailable";
    default:
      return "other";
  }
}

/**
 * Collapses every panel's failure and "served stale" flag into one banner. A single failed panel
 * (comments, say) still counts, but the page keeps rendering whatever else it has.
 */
export function resolveLinearDegradation(input: {
  readonly failures: ReadonlyArray<unknown>;
  readonly stale: boolean;
  readonly status: Pick<LinearConnectionStatus, "rateLimitedUntil"> | null;
  readonly now: number;
}): LinearDegradation | null {
  const kinds = input.failures.map(classifyLinearFailure);
  if (kinds.includes("rate_limited")) return "rate_limited";
  const limitedUntil =
    input.status?.rateLimitedUntil == null ? null : Date.parse(input.status.rateLimitedUntil);
  if (limitedUntil !== null && limitedUntil > input.now) return "rate_limited";
  if (kinds.includes("unavailable")) return "unavailable";
  return input.stale ? "unavailable" : null;
}

/**
 * A server that predates Linear answers its RPCs with an "Unknown request tag" defect rather
 * than a LinearError, which clients show as "update the server" instead of "Linear is down".
 */
export function isLinearUnsupportedFailure(failure: unknown): boolean {
  const message =
    typeof failure === "string"
      ? failure
      : failure instanceof Error
        ? failure.message
        : typeof failure === "object" && failure !== null && "message" in failure
          ? String((failure as { readonly message: unknown }).message)
          : "";
  return /unknown request tag/iu.test(message);
}
