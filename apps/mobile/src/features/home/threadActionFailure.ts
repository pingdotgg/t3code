import * as Cause from "effect/Cause";

/**
 * Why the server rejected a thread list action, when that changes what the user can do next.
 * "missing": the server has no such thread, so the row is a stale copy.
 * "archived": the thread is archived, so it is already out of the active list.
 */
export type ThreadActionFailureKind = "missing" | "archived" | "other";

export interface ThreadActionFailure {
  readonly kind: ThreadActionFailureKind;
  readonly message: string | null;
}

// The server's own wording (orchestration-v2 Orchestrator and ProjectionStore). It reaches the
// client as the dispatch error's detail, and older servers send the same text.
const MISSING_THREAD_PATTERNS = [
  /^No orchestration projection exists for thread /,
  / is deleted\.$/,
];
const ARCHIVED_THREAD_PATTERN = /^Thread .+ is archived\.$/;

function failureMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { detail, message } = error as { detail?: unknown; message?: unknown };
  for (const text of [detail, message]) {
    if (typeof text === "string" && text.trim().length > 0) return text.trim();
  }
  return null;
}

export function classifyThreadActionFailure(cause: Cause.Cause<unknown>): ThreadActionFailure {
  const message = failureMessage(Cause.squash(cause));
  if (message === null) return { kind: "other", message };
  if (MISSING_THREAD_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "missing", message };
  }
  if (ARCHIVED_THREAD_PATTERN.test(message)) return { kind: "archived", message };
  return { kind: "other", message };
}
