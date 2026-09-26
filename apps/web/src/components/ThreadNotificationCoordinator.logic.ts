import type { SidebarThreadStatus } from "./Sidebar.logic";

/**
 * How long a ready completion that just left background liveness waits
 * before it counts as a finished run. The follow-up shell (resume hold or
 * the next turn) lands in this window; a run that stays ready is announced
 * when it elapses.
 */
export const BACKGROUND_RESUME_GAP_MS = 250;

export interface ThreadNotificationMarker {
  readonly attention: string | null;
  readonly completion: number | null;
  readonly background: boolean;
  readonly deferredCompletion: number | null;
}

/**
 * Completion sound, toast, and desktop notification share this decision.
 * A waiting turn's completedAt becomes visible when background work drops
 * and before the provider resumes. That snapshot is not a finished run:
 * defer it, and drop it if working or monitoring liveness returns. A run
 * that stays ready still alerts once.
 */
export function resolveThreadNotification(input: {
  readonly status: SidebarThreadStatus;
  readonly attentionKey: string;
  readonly settledCompletion: number | null;
  readonly background: boolean;
  readonly sessionLive: boolean;
  readonly prior: ThreadNotificationMarker | null;
  readonly deferralDue: boolean;
}): {
  readonly marker: ThreadNotificationMarker;
  readonly kind: "input" | "completion" | null;
  readonly armDeferral: boolean;
  readonly clearDeferral: boolean;
} {
  const prior = input.prior;
  const settledCompletion = input.status === "ready" ? input.settledCompletion : null;
  const attention =
    input.status === "input" || input.status === "approval" || input.status === "failed"
      ? input.attentionKey
      : null;
  const liveAgain =
    input.background ||
    input.sessionLive ||
    input.status === "working" ||
    input.status === "monitoring";
  const completionIsNew =
    settledCompletion !== null &&
    (prior === null || prior.completion === null || settledCompletion > prior.completion);
  const defer =
    prior !== null &&
    prior.background &&
    !liveAgain &&
    input.status === "ready" &&
    completionIsNew &&
    !input.deferralDue;
  const replacedDeferral =
    prior?.deferredCompletion != null &&
    settledCompletion !== null &&
    settledCompletion !== prior.deferredCompletion;
  const deferredCompletion = defer
    ? settledCompletion
    : input.deferralDue || liveAgain || replacedDeferral
      ? null
      : (prior?.deferredCompletion ?? null);
  const waiting =
    deferredCompletion !== null &&
    settledCompletion === deferredCompletion &&
    input.status === "ready";
  const completion = waiting
    ? (prior?.completion ?? null)
    : (settledCompletion ?? prior?.completion ?? null);
  const marker: ThreadNotificationMarker = {
    attention,
    completion,
    background: input.background,
    deferredCompletion,
  };
  const clearDeferral =
    prior?.deferredCompletion != null &&
    !defer &&
    (liveAgain || input.deferralDue || replacedDeferral || input.status !== "ready");
  if (prior === null) {
    return { marker, kind: null, armDeferral: false, clearDeferral: false };
  }
  const kind =
    attention !== null && attention !== prior.attention
      ? "input"
      : !waiting &&
          completion !== null &&
          (prior.completion === null || completion > prior.completion)
        ? "completion"
        : null;
  return { marker, kind, armDeferral: defer, clearDeferral };
}
