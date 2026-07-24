/**
 * Delegated sub-agent threads (spawned via the server's `delegate_task`
 * tool) render as inline task cards inside their parent thread, never as
 * rows in the thread list. The persisted parent link is the primary signal;
 * the server-written `Agent: ` title prefix covers rows that predate it.
 */
export function isDelegatedAgentThread(thread: {
  readonly title: string;
  readonly parentThreadId?: string | null;
}): boolean {
  if (typeof thread.parentThreadId === "string" && thread.parentThreadId.length > 0) {
    return true;
  }
  return thread.title.startsWith("Agent: ");
}
