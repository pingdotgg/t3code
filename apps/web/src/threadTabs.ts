import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef, ThreadId, ThreadTabType } from "@t3tools/contracts";

import type { SidebarThreadSummary, Thread } from "./types";

export interface ThreadContentTab {
  readonly id: ThreadId;
  readonly type: ThreadTabType;
  readonly title: string;
  readonly threadRef: ScopedThreadRef;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string | undefined;
}

export function threadTabGroupId(thread: Pick<Thread, "id" | "tabGroupId">): ThreadId {
  return thread.tabGroupId || thread.id;
}

export function sidebarThreadTabGroupId(
  thread: Pick<SidebarThreadSummary, "id" | "tabGroupId">,
): ThreadId {
  return thread.tabGroupId || thread.id;
}

export function buildThreadContentTabs(input: {
  readonly activeThread: Thread | null | undefined;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly sidebarThreads: ReadonlyArray<SidebarThreadSummary>;
}): ThreadContentTab[] {
  const activeThread = input.activeThread;
  const activeThreadRef = input.activeThreadRef;
  if (!activeThread || !activeThreadRef || activeThread.archivedAt !== null) {
    return [];
  }

  const activeGroupId = threadTabGroupId(activeThread);
  const activeThreadKey = scopedThreadKey(activeThreadRef);
  const tabs = input.sidebarThreads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.environmentId === activeThread.environmentId &&
        sidebarThreadTabGroupId(thread) === activeGroupId &&
        (thread.tabType ?? "chat") === "chat",
    )
    .map(
      (thread): ThreadContentTab => ({
        id: thread.id,
        type: thread.tabType ?? "chat",
        title: thread.title,
        threadRef: scopeThreadRef(thread.environmentId, thread.id),
        active:
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      }),
    );

  if (!tabs.some((tab) => tab.id === activeThread.id)) {
    tabs.push({
      id: activeThread.id,
      type: activeThread.tabType ?? "chat",
      title: activeThread.title,
      threadRef: activeThreadRef,
      active: true,
      createdAt: activeThread.createdAt,
      updatedAt: activeThread.updatedAt,
    });
  }

  return tabs.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export function resolveFallbackThreadTabAfterClose(
  tabs: ReadonlyArray<ThreadContentTab>,
  closedTab: ThreadContentTab,
): ThreadContentTab | null {
  const closedTabKey = scopedThreadKey(closedTab.threadRef);
  const closedIndex = tabs.findIndex((tab) => scopedThreadKey(tab.threadRef) === closedTabKey);
  if (closedIndex === -1) {
    return null;
  }

  return tabs[closedIndex + 1] ?? tabs[closedIndex - 1] ?? null;
}
