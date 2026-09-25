/**
 * Child-thread identity (toolboxmd/t3code#8): a thread spawned by another
 * thread through the `threads` MCP toolkit carries its parent in its own id,
 * `sub.<parentThreadId>.<suffix>`.
 *
 * A real optional `parentThreadId` on `thread.create` carried to the thread
 * shell would be cleaner, but it is too invasive for this fork: it would
 * require coordinated changes to ThreadCreateCommand, ThreadCreatedPayload,
 * OrchestrationThread, OrchestrationThreadShell, the decider, the projector,
 * the ProjectionThread persistence schema plus SQLite layer plus a new
 * migration, and the shell snapshot mapping, with backfill for existing
 * threads. The id convention needs none of that, survives restarts, and lets
 * every client classify a thread from its shell alone.
 *
 * Keep in sync with apps/web/src/components/subagentThreads.ts.
 */
const PREFIX = "sub.";

export function makeSubagentThreadId(parentThreadId: string, suffix: string): string {
  return `${PREFIX}${parentThreadId}.${suffix}`;
}

export function isSubagentThreadId(threadId: string): boolean {
  return threadId.startsWith(PREFIX) && threadId.lastIndexOf(".") > PREFIX.length;
}

/** The spawning thread's id, or null for a thread the user started. */
export function parentThreadIdOf(threadId: string): string | null {
  if (!isSubagentThreadId(threadId)) return null;
  return threadId.slice(PREFIX.length, threadId.lastIndexOf("."));
}
