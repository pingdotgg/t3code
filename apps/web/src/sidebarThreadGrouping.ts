import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import type { ThreadGroup } from "./uiStateStore";
import type { SidebarThreadSummary } from "./types";

/** A folder plus the visible threads it currently holds, in folder order. */
export interface ThreadGroupSection {
  group: ThreadGroup;
  threads: SidebarThreadSummary[];
  expanded: boolean;
}

export interface GroupedThreadLayout {
  /** Folder sections in the project's folder order. */
  sections: ThreadGroupSection[];
  /** Threads not in any folder, preserving the input sort order. */
  ungroupedThreads: SidebarThreadSummary[];
}

export function threadKeyOf(thread: SidebarThreadSummary): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/**
 * Split a project's (already sorted, non-archived) threads into ordered folder
 * sections plus the remaining ungrouped threads. Pure: no store access, so it is
 * straightforward to unit test. Folders that reference threads not present in
 * `visibleProjectThreads` simply render fewer rows; threads in no folder fall
 * through to `ungroupedThreads`.
 */
export function buildGroupedThreadLayout(input: {
  visibleProjectThreads: readonly SidebarThreadSummary[];
  projectKey: string;
  groups: Record<string, ThreadGroup>;
  groupOrder: readonly string[];
  groupExpandedById: Record<string, boolean>;
}): GroupedThreadLayout {
  const { visibleProjectThreads, projectKey, groups, groupOrder, groupExpandedById } = input;

  const threadByKey = new Map<string, SidebarThreadSummary>();
  for (const thread of visibleProjectThreads) {
    threadByKey.set(threadKeyOf(thread), thread);
  }

  const claimed = new Set<string>();
  const sections: ThreadGroupSection[] = [];
  for (const groupId of groupOrder) {
    const group = groups[groupId];
    if (!group || group.projectKey !== projectKey) {
      continue;
    }
    const threads: SidebarThreadSummary[] = [];
    for (const threadKey of group.threadKeys) {
      const thread = threadByKey.get(threadKey);
      if (thread) {
        threads.push(thread);
        claimed.add(threadKey);
      }
    }
    sections.push({
      group,
      threads,
      expanded: groupExpandedById[groupId] ?? true,
    });
  }

  const ungroupedThreads = visibleProjectThreads.filter(
    (thread) => !claimed.has(threadKeyOf(thread)),
  );

  return { sections, ungroupedThreads };
}
