import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export const legacyStaleRequestFailureDetails = {
  "provider.approval.respond.failed": [
    "stale pending approval request",
    "unknown pending approval request",
    "unknown pending permission request",
    "unknown pending codex approval request",
  ],
  "provider.user-input.respond.failed": [
    "stale pending user-input request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request",
  ],
} as const;

/** Reads the failure fact, with a fallback for activities saved by older servers. */
export function isRequestResponseStale(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): boolean {
  if (
    activity.kind !== "provider.approval.respond.failed" &&
    activity.kind !== "provider.user-input.respond.failed"
  ) {
    return false;
  }
  const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;
  if (!payload) return false;

  // Unknown future reasons must not fall back to matching display text.
  if ("reason" in payload) return payload.reason === "request-not-found";
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return legacyStaleRequestFailureDetails[activity.kind].some((fragment) =>
    detail.includes(fragment),
  );
}
