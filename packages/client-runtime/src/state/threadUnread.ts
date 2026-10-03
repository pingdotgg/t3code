import type { RunId } from "@t3tools/contracts";

/**
 * The unread window of a thread, copied when it opens: everything after the
 * last visit, up to the completion that made the thread unread.
 */
export interface ThreadUnreadSnapshot {
  readonly visitedAt: string;
  readonly runId: RunId;
  readonly completedAt: string;
}

/** One scoped thread staying open. `snapshot` is null when it opened read. */
export interface ThreadUnreadSession {
  readonly threadKey: string;
  readonly snapshot: ThreadUnreadSnapshot | null;
}

interface ThreadReadState {
  /** Effective visit watermark. Null or absent means the thread has none. */
  readonly lastVisitedAt?: string | null | undefined;
  readonly latestRun: { readonly runId: RunId; readonly completedAt: string | null } | null;
}

/**
 * The unread window by the thread list's rule: the latest run completed after
 * the last visit. A thread that was never visited, is already read, or has an
 * unparseable visit has no window.
 */
function captureThreadUnreadSnapshot(thread: ThreadReadState): ThreadUnreadSnapshot | null {
  const { lastVisitedAt, latestRun } = thread;
  if (!lastVisitedAt || !latestRun?.completedAt) return null;
  return Date.parse(latestRun.completedAt) > Date.parse(lastVisitedAt)
    ? { visitedAt: lastVisitedAt, runId: latestRun.runId, completedAt: latestRun.completedAt }
    : null;
}

/**
 * Advances the unread session of the open thread. Call it during render,
 * before the effect that records the visit, and keep the result in state.
 * The session is copied once per `threadKey` and then frozen: read echoes,
 * later completions and reconnects return `current` unchanged. A null
 * `threadKey` (nothing on screen) or a different key ends it.
 */
export function resolveThreadUnreadSession(
  current: ThreadUnreadSession | null,
  input: {
    readonly threadKey: string | null;
    /** Null until the thread's shell has loaded. */
    readonly thread: ThreadReadState | null;
    /** False while the shell may be a cached copy from before a sync. */
    readonly synchronized: boolean;
  },
): ThreadUnreadSession | null {
  if (input.threadKey === null) return null;
  if (current?.threadKey === input.threadKey) return current;
  if (input.thread === null) return null;
  const snapshot = captureThreadUnreadSnapshot(input.thread);
  // A cached shell can predate the completion the user came back for, so only
  // a synchronized shell may settle the session as read.
  if (snapshot === null && !input.synchronized) return null;
  return { threadKey: input.threadKey, snapshot };
}

/**
 * Whether an entry was created by the time the unread window closed. Anything
 * later is not unread, and neither is an entry only this client has (null).
 */
export function createdByUnreadWindowEnd(
  entry: { readonly createdAt: string } | null,
  snapshot: ThreadUnreadSnapshot,
): boolean {
  return entry !== null && Date.parse(entry.createdAt) <= Date.parse(snapshot.completedAt);
}

/** What one timeline entry contributes to placing the unread boundary. */
export interface UnreadBoundaryCandidate {
  readonly createdAt: string;
  /** The run of an assistant message. Null for every other entry. */
  readonly assistantRunId: RunId | null;
}

/**
 * Index of the entry the "New" divider sits above, or -1 for none. `entries`
 * run oldest first. Pass null for entries only this client has (optimistic
 * sends), which are never unread.
 *
 * The boundary is the first entry created inside the unread window. Its
 * fallback is the last assistant message of the unread run, which covers an
 * answer that began streaming before the visit and Mark unread, where the
 * visit sits 1ms before the completion. The earlier of the two wins. Entries
 * created after the window are ignored for both, so nothing that arrives
 * later can create or move the boundary.
 */
export function resolveUnreadBoundaryIndex(
  entries: ReadonlyArray<UnreadBoundaryCandidate | null>,
  snapshot: ThreadUnreadSnapshot,
  options: { readonly hasMoreHistory: boolean },
): number {
  const visitedAt = Date.parse(snapshot.visitedAt);
  let firstNew = -1;
  let lastAnswer = -1;
  for (const [index, entry] of entries.entries()) {
    // The window closes at the completion, for the fallback too: a late item
    // of the same run must not pull the divider down.
    if (entry === null || !createdByUnreadWindowEnd(entry, snapshot)) continue;
    if (entry.assistantRunId === snapshot.runId) lastAnswer = index;
    if (firstNew < 0 && Date.parse(entry.createdAt) > visitedAt) firstNew = index;
  }
  const boundary =
    firstNew < 0 ? lastAnswer : lastAnswer < 0 ? firstNew : Math.min(firstNew, lastAnswer);
  // With older pages unloaded, the first loaded entry may sit below the real
  // boundary. Loading them recomputes this from the same snapshot.
  return boundary === 0 && options.hasMoreHistory ? -1 : boundary;
}
