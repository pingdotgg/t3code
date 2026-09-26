import type { QueuedComposerMessage } from "~/queuedMessageStore";

/**
 * Minimum gap between two whip messages. The whip cracks as often as the
 * user likes; only the order to the agent waits for this delta.
 */
export const WHIP_COOLDOWN_MS = 8_000;

/**
 * The whip is a canned steer for a turn that looks stuck. Repeating "go on"
 * only interrupts the agent, so each message asks for one line on the
 * blocker and a decision. They rotate so consecutive cracks do not read as
 * the same string twice.
 */
export const WHIP_PROMPTS = [
  "Whip! You look stuck. One line on what is blocking you, then pick the simplest reasonable option yourself and keep going. Do not stop to ask.",
  "Whip! Stop deliberating. Commit to the most direct path, do it, and only report back when there is real progress.",
  "Whip! Still spinning? Cut scope if you must, but get something working now. State your assumption in one line and move on.",
  "Whip! Enough analysis. Decide, implement, verify. If a step is truly impossible, say so in one line and do the next best thing.",
] as const;

export function buildWhipQueuedMessage(input: {
  queuedAfterToolActivityId: string | null;
  /** How many whips went out before this one; picks the prompt variant. */
  crack: number;
}): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt: WHIP_PROMPTS[input.crack % WHIP_PROMPTS.length]!,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    queuedAfterToolActivityId: input.queuedAfterToolActivityId,
    createdAt: new Date().toISOString(),
  };
}
