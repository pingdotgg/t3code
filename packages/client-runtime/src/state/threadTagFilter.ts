import {
  isListedThreadLineage,
  isThreadHiddenByTagFilter,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadTagFilter,
} from "@t3tools/contracts";

type FilterableThread = Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "tags">;

/**
 * Drops threads the tag filter hides. Subagents and side chats follow the
 * listed thread they live under, so hiding a thread hides its children and
 * `only` keeps them. Returns the input array when nothing is hidden.
 */
export function filterThreadsByTagFilter<Thread extends FilterableThread>(
  threads: ReadonlyArray<Thread>,
  filter: ThreadTagFilter | null | undefined,
): ReadonlyArray<Thread> {
  if (!filter?.enabled) return threads;
  const byId = new Map<ThreadId, Thread>(threads.map((thread) => [thread.id, thread]));
  const hiddenById = new Map<ThreadId, boolean>();
  const isHidden = (thread: Thread): boolean => {
    const known = hiddenById.get(thread.id);
    if (known !== undefined) return known;
    // Seed before recursing so a malformed parent cycle ends on the thread's own tags.
    hiddenById.set(thread.id, isThreadHiddenByTagFilter(thread.tags, filter));
    const parentId = thread.lineage.parentThreadId;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (!isListedThreadLineage(thread.lineage) && parent !== undefined) {
      hiddenById.set(thread.id, isHidden(parent));
    }
    return hiddenById.get(thread.id)!;
  };
  const visible = threads.filter((thread) => !isHidden(thread));
  return visible.length === threads.length ? threads : visible;
}
