import type { OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: edge states of the create's completion, as the owner decided them (spec Q3-Q7, 2026-11-14).
 * Q3 is `orbitRemoveWaitTextBehindCompletion` in the web app; Q4 is `orbitCompletionCancelled`;
 * Q5 needs no switch: every new Instance starts with a first prompt. Q6: the phone follows the
 * completion too (`apps/mobile/src/features/orbit/orbitThreadStarts.ts`).
 */

/**
 * Q7: a Project process that did not start in the completion. Orbit takes a plain Retry there,
 * so the card says "…then retry" whenever Orbit offers one, not only with `requires`.
 */
export function orbitCompletionProcessFailureCanRetry(start: OrbitThreadStart): boolean {
  return start.completionRetryable === true;
}
