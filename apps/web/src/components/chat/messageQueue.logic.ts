import type { SessionPhase } from "~/types";

/**
 * Whether a submitted prompt has to wait instead of going out right away.
 *
 * A non-empty queue queues too: jumping the line would reorder prompts the
 * user already committed to a sequence. `disconnected` is not "busy" — the
 * agent is stopped or errored there, and sending is what revives the thread.
 */
export function shouldQueueOutgoingMessage(input: {
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly queuedCount: number;
}): boolean {
  if (input.queuedCount > 0) {
    return true;
  }
  return (
    input.phase === "running" ||
    input.phase === "connecting" ||
    input.isSendBusy ||
    input.hasPendingApproval ||
    input.hasPendingUserInput
  );
}

/**
 * One-line label for a queued entry. The stored text can carry folded
 * contexts over many lines, so the first non-empty line stands in for it;
 * an image-only prompt has no text at all.
 */
export function formatQueuedMessagePreview(input: {
  readonly text: string;
  readonly imageCount: number;
}): string {
  const firstLine = input.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    return firstLine;
  }
  if (input.imageCount > 0) {
    return input.imageCount === 1 ? "1 image" : `${input.imageCount} images`;
  }
  return "Empty message";
}

/**
 * Whether the head of the queue may be sent now. This is the "the agent is
 * done and waiting for a new instruction" state — every open question counts
 * as not done, including an actionable proposed plan, which needs the user's
 * decision rather than the next prompt.
 *
 * Idleness is read from the session (`ready` plus no active turn), never from
 * the latest turn: a steered turn stays projected as a pending row without a
 * turn id, which clears the thread's latest turn and would keep a
 * turn-based check closed forever.
 *
 * `disconnected` is excluded on purpose: after an error or a stopped session
 * an automatic send would silently revive the thread. Those entries wait for
 * the explicit send action.
 */
export function canFlushQueuedMessage(input: {
  readonly phase: SessionPhase;
  readonly hasActiveTurn: boolean;
  readonly isSendBusy: boolean;
  readonly isSendInFlight: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
}): boolean {
  return (
    input.phase === "ready" &&
    !input.hasActiveTurn &&
    !input.isSendBusy &&
    !input.isSendInFlight &&
    !input.hasPendingApproval &&
    !input.hasPendingUserInput &&
    !input.hasActionableProposedPlan
  );
}
