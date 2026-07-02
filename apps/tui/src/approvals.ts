import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { isStalePendingRequestFailureDetail } from "./staleRequest.ts";

export interface PendingApproval {
  readonly requestId: string;
  readonly requestKind: string;
  readonly detail?: string;
  readonly createdAt: string;
}

/**
 * Derive the still-open approval requests for a thread from its activity log.
 * Mirrors the web client's logic: an `approval.requested` activity opens a
 * request, and a later `approval.resolved` (or stale-request failure) closes
 * it. Kept intentionally small — the TUI only needs requestId + a label.
 */
export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const open = new Map<string, PendingApproval>();
  const ordered = [...activities].sort((a, b) => {
    const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.createdAt.localeCompare(b.createdAt);
  });

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string" ? payload.requestId : null;

    if (activity.kind === "approval.requested" && requestId) {
      const requestKind =
        payload && typeof payload.requestKind === "string"
          ? payload.requestKind
          : "approval";
      const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
      open.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (requestId && activity.kind === "approval.resolved") {
      open.delete(requestId);
      continue;
    }

    // A respond failure only closes the request when the provider reports it
    // stale/unknown — a transient failure (network blip) leaves it open so the
    // user can retry, matching the web derivation.
    if (requestId && activity.kind === "provider.approval.respond.failed") {
      const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
      if (isStalePendingRequestFailureDetail(detail)) {
        open.delete(requestId);
      }
    }
  }

  return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
