import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import {
  normalizeParentThreadKeys,
  selectVisibleSidebarThreads,
  sidebarThreadKey,
} from "../sidebarThreadTree";
import type { SidebarThreadSummary } from "../types";
import {
  hasUnseenChildNotification,
  hasUnseenCompletion,
  resolveThreadStatusPill,
} from "./Sidebar.logic";

export type ThreadTooltipStatus =
  | "approval"
  | "input"
  | "plan"
  | "working"
  | "connecting"
  | "failed"
  | "stopped"
  | "done"
  | "idle";

const STATUS_PRIORITY: Record<ThreadTooltipStatus, number> = {
  approval: 0,
  input: 0,
  plan: 0,
  failed: 0,
  working: 1,
  connecting: 1,
  done: 2,
  stopped: 3,
  idle: 3,
};

const BLOCKER_LABELS: Partial<Record<ThreadTooltipStatus, string>> = {
  approval: "Waiting for approval",
  input: "Waiting for your answer",
  plan: "Plan ready for review",
  failed: "Thread needs attention",
};

export function selectThreadTooltipChildren(
  threads: readonly SidebarThreadSummary[],
  parentKey: string,
): SidebarThreadSummary[] {
  const visible = selectVisibleSidebarThreads(threads);
  const parentByKey = normalizeParentThreadKeys(visible);
  return visible.filter((thread) => parentByKey.get(sidebarThreadKey(thread)) === parentKey);
}

function resolveThreadTooltipStatus(
  thread: SidebarThreadSummary,
  hasPendingTurn: boolean,
): ThreadTooltipStatus {
  const status = resolveThreadStatusPill({ thread, lastVisitedAt: undefined, hasPendingTurn });
  switch (status?.label) {
    case "Pending Approval":
      return "approval";
    case "Awaiting Input":
      return "input";
    case "Plan Ready":
      return "plan";
    case "Working":
      return "working";
    case "Connecting":
      return "connecting";
  }
  if (
    thread.virtualAgentRun?.status === "failed" ||
    thread.session?.status === "error" ||
    thread.latestTurn?.state === "error"
  ) {
    return "failed";
  }
  if (thread.virtualAgentRun?.status === "stopped" || thread.latestTurn?.state === "interrupted") {
    return "stopped";
  }
  return thread.virtualAgentRun?.status === "completed" || thread.latestTurn?.state === "completed"
    ? "done"
    : "idle";
}

export function buildThreadTooltipActivity({
  thread,
  children,
  lastVisitedAtByThreadKey,
  pendingThreadKeys,
}: {
  readonly thread: SidebarThreadSummary;
  readonly children: readonly SidebarThreadSummary[];
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string>>;
  readonly pendingThreadKeys: ReadonlySet<string>;
}) {
  const parentKey = sidebarThreadKey(thread);
  const childRows = children.map((child) => {
    const key = sidebarThreadKey(child);
    const status = resolveThreadTooltipStatus(child, pendingThreadKeys.has(key));
    const visitKey = child.virtualAgentRun
      ? scopedThreadKey(scopeThreadRef(child.environmentId, child.virtualAgentRun.parentThreadId))
      : key;
    const lastVisitedAt = lastVisitedAtByThreadKey[visitKey];
    const unread =
      status === "done" &&
      (child.virtualAgentRun
        ? hasUnseenChildNotification({
            latestChildNotificationAt: child.updatedAt ?? child.createdAt,
            lastVisitedAt,
          })
        : hasUnseenCompletion({ latestTurn: child.latestTurn, lastVisitedAt }));
    return { thread: child, key, status, unread };
  });
  childRows.sort(
    (left, right) =>
      STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
      Number(right.unread) - Number(left.unread) ||
      (right.thread.updatedAt ?? right.thread.createdAt).localeCompare(
        left.thread.updatedAt ?? left.thread.createdAt,
      ) ||
      left.key.localeCompare(right.key),
  );

  return {
    blocker:
      BLOCKER_LABELS[resolveThreadTooltipStatus(thread, pendingThreadKeys.has(parentKey))] ?? null,
    hasUnreadChildUpdate: hasUnseenChildNotification({
      latestChildNotificationAt: thread.latestChildNotificationAt,
      lastVisitedAt: lastVisitedAtByThreadKey[parentKey],
    }),
    childCount: childRows.length,
    unreadResultCount: childRows.filter((child) => child.unread).length,
    children: childRows.slice(0, 3),
    remainingChildCount: Math.max(0, childRows.length - 3),
  };
}
