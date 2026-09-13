import type { OrchestrationShellSnapshot, OrchestrationShellStreamItem } from "@t3tools/contracts";

/** Older clients require a project ID on every thread they receive. */
export function projectQuickChatShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
  includeQuickChats: boolean | undefined,
): OrchestrationShellSnapshot {
  return includeQuickChats
    ? snapshot
    : { ...snapshot, threads: snapshot.threads.filter((thread) => thread.projectId !== null) };
}

export function projectQuickChatShellItem(
  item: OrchestrationShellStreamItem,
  includeQuickChats: boolean | undefined,
): OrchestrationShellStreamItem {
  if (includeQuickChats) return item;
  if (item.kind === "snapshot") {
    return { ...item, snapshot: projectQuickChatShellSnapshot(item.snapshot, false) };
  }
  if (item.kind === "thread-upserted" && item.thread.projectId === null) {
    // Keep the replay cursor advancing even when the thread is hidden.
    return { kind: "thread-removed", sequence: item.sequence, threadId: item.thread.id };
  }
  return item;
}
