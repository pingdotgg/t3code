import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { SidebarVariant } from "@t3tools/contracts/settings";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  type SidebarSection,
  type SidebarThreadStatus,
} from "../../Sidebar.logic";

export type VariantRowStyle = "folder-detailed" | "folder-slim";
export type RowAttention = "need" | "failed" | "done";
export type WorkerBucket = "need" | "failed" | "working" | "done" | "idle";

/** The row a variant draws, or null for T3's own row in that place. */
export function variantRowStyle(
  variant: SidebarVariant,
  section: SidebarSection,
  inFolder: boolean,
): VariantRowStyle | null {
  if (variant === "detailed" && inFolder) return "folder-detailed";
  if (variant === "slim" && (inFolder || section === "pinned")) return "folder-slim";
  return null;
}

export function rowAttention(
  status: SidebarThreadStatus,
  isUnread: boolean,
): RowAttention | undefined {
  switch (status) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      return "need";
    case "failed":
      return "failed";
    case "ready":
      return isUnread ? "done" : undefined;
    default:
      return undefined;
  }
}

export function workerBucket(thread: EnvironmentThreadShell): WorkerBucket {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "request") return "need";
  if (status === "failed" || status === "limited") return "failed";
  if (status === "working" || status === "preparing" || status === "waiting") return "working";
  return thread.latestRun?.completedAt || hasUnseenCompletion(thread) ? "done" : "idle";
}

export type WorkerMap = ReadonlyMap<string, readonly EnvironmentThreadShell[]>;

export function workersByParent(threads: readonly EnvironmentThreadShell[]): WorkerMap {
  const byParent = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const parent = thread.lineage.parentThreadId;
    if (parent === null || thread.lineage.relationshipToParent !== "subagent") continue;
    if (thread.archivedAt !== null) continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, parent));
    byParent.set(key, [...(byParent.get(key) ?? []), thread]);
  }
  return byParent;
}

const threadKeyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export const workersOf = (workers: WorkerMap, thread: EnvironmentThreadShell) =>
  workers.get(threadKeyOf(thread)) ?? [];

/** Creation order never changes, so nothing a thread does can move its row. */
export function arrangeStableRows<
  T extends { readonly id: string; readonly createdAt: string; readonly pinnedAt?: string | null },
>(threads: readonly T[]): T[] {
  const newestFirst = (left: T, right: T) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
  return [
    ...threads.filter((thread) => thread.pinnedAt != null).toSorted(newestFirst),
    ...threads.filter((thread) => thread.pinnedAt == null).toSorted(newestFirst),
  ];
}

function parkedLabel(snoozed: number, settled: number): string {
  return [snoozed > 0 ? `${snoozed} snoozed` : null, settled > 0 ? `${settled} settled` : null]
    .filter((part) => part !== null)
    .join(" · ");
}

export type DetailedFolderItem =
  | {
      readonly kind: "thread";
      readonly thread: EnvironmentThreadShell;
      readonly section: SidebarSection;
      readonly nested: boolean;
    }
  | {
      readonly kind: "workers";
      readonly parentKey: string;
      readonly workers: readonly EnvironmentThreadShell[];
      readonly open: boolean;
    }
  | { readonly kind: "parked"; readonly label: string; readonly open: boolean };

export function arrangeDetailedFolder(input: {
  readonly collapsed: boolean;
  readonly pinned: readonly EnvironmentThreadShell[];
  readonly active: readonly EnvironmentThreadShell[];
  readonly snoozed: readonly EnvironmentThreadShell[];
  readonly settled: readonly EnvironmentThreadShell[];
  readonly workers: WorkerMap;
  readonly workerFold: ReadonlyMap<string, boolean>;
  readonly parkedOpen: boolean;
  /** The row standing for the open thread; a closed group still shows it. */
  readonly routeRowKey: string | null;
  /** The open thread itself, which may be a worker. */
  readonly routeThreadKey: string | null;
}): {
  readonly items: readonly DetailedFolderItem[];
  readonly hiddenThreads: readonly EnvironmentThreadShell[];
} {
  const { collapsed, routeRowKey } = input;
  const isRouteRow = (thread: EnvironmentThreadShell) => threadKeyOf(thread) === routeRowKey;
  const main = arrangeStableRows([...input.pinned, ...input.active]);
  const items: DetailedFolderItem[] = [];
  for (const thread of main) {
    if (collapsed && !isRouteRow(thread)) continue;
    items.push({
      kind: "thread",
      thread,
      section: thread.pinnedAt != null ? "pinned" : "active",
      nested: false,
    });
    const workers = workersOf(input.workers, thread);
    if (workers.length === 0) continue;
    const parentKey = threadKeyOf(thread);
    const open =
      !collapsed &&
      (input.workerFold.get(parentKey) ??
        workers.some((worker) => workerBucket(worker) === "need"));
    if (!collapsed) items.push({ kind: "workers", parentKey, workers, open });
    for (const worker of arrangeStableRows(workers)) {
      if (open || threadKeyOf(worker) === input.routeThreadKey) {
        items.push({ kind: "thread", thread: worker, section: "active", nested: true });
      }
    }
  }
  const parkedCount = input.snoozed.length + input.settled.length;
  const parkedOpen = !collapsed && input.parkedOpen;
  if (!collapsed && parkedCount > 0) {
    items.push({
      kind: "parked",
      label: parkedLabel(input.snoozed.length, input.settled.length),
      open: parkedOpen,
    });
  }
  for (const [list, section] of [
    [input.snoozed, "snoozed"],
    [input.settled, "settled"],
  ] as const) {
    for (const thread of list) {
      if (parkedOpen || isRouteRow(thread)) {
        items.push({ kind: "thread", thread, section, nested: false });
      }
    }
  }
  return { items, hiddenThreads: collapsed ? main.filter((thread) => !isRouteRow(thread)) : [] };
}

/** Threads asking the user something themselves; a parent raising a worker's ask is not one. */
export function threadsWaitingOnYou(
  threads: readonly EnvironmentThreadShell[],
  scopedProjectKeys: ReadonlySet<string> | null,
): EnvironmentThreadShell[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)) &&
      (thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        (thread.pendingGuestMessageCount ?? 0) > 0),
  );
}
