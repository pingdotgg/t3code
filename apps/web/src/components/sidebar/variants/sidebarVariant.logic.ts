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
export type RowAttention = "warning" | "input" | "guest" | "error" | "success";

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

/** The state colour of a row that wants the user, or undefined for a quiet row. */
export function rowAttention(
  status: SidebarThreadStatus,
  isUnread: boolean,
): RowAttention | undefined {
  switch (status) {
    case "approval":
    case "limited":
      return "warning";
    case "input":
      return "input";
    case "request":
      return "guest";
    case "failed":
      return "error";
    case "ready":
      return isUnread ? "success" : undefined;
    default:
      return undefined;
  }
}

function workerNeedsYou(thread: EnvironmentThreadShell): boolean {
  const status = resolveSidebarThreadStatus(thread);
  return status === "approval" || status === "input" || status === "request";
}

/** A worker's rank and the count's two word forms; a higher rank names the count. */
function workerState(thread: EnvironmentThreadShell): readonly [number, string, string] | null {
  switch (resolveSidebarThreadStatus(thread)) {
    case "failed":
      return [8, "error", "errors"];
    case "limited":
      return [8, "limited", "limited"];
    case "approval":
      return [7, "approval", "approvals"];
    case "input":
      return [6, "question", "questions"];
    case "request":
      return [6, "request", "requests"];
    case "working":
    case "preparing":
    case "waiting":
      return [5, "working", "working"];
    default:
      return thread.latestRun?.completedAt || hasUnseenCompletion(thread)
        ? [2, "done", "done"]
        : null;
  }
}

export function workerTotal(count: number): string {
  return `${count} ${count === 1 ? "worker" : "workers"}`;
}

/** The total, then how many share the most urgent state: "2 workers · 1 working". */
export function workerSummary(workers: readonly EnvironmentThreadShell[]): string {
  const total = workerTotal(workers.length);
  const states = workers.map(workerState).filter((state) => state !== null);
  const top = states.reduce<(typeof states)[number] | null>(
    (best, state) => (best === null || state[0] > best[0] ? state : best),
    null,
  );
  if (top === null) return total;
  const count = states.filter((state) => state[1] === top[1]).length;
  return `${total} · ${count} ${count === 1 ? top[1] : top[2]}`;
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

/** A folder shows while it holds a thread, or when the sidebar keeps it empty. */
export function detailedFolderShows(
  lists: Readonly<Record<string, readonly unknown[]>>,
  keepEmpty: boolean,
): boolean {
  return keepEmpty || Object.values(lists).some((list) => list.length > 0);
}

export type DetailedFolderItem =
  | {
      readonly kind: "thread";
      readonly thread: EnvironmentThreadShell;
      readonly section: SidebarSection;
      readonly nested: boolean;
      /** The last worker shown under its parent, where the guide turns in. */
      readonly lastNested: boolean;
      /** Whether its worker rows show; null when the row cannot fold them. */
      readonly workersOpen: boolean | null;
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
    const workers = workersOf(input.workers, thread);
    const parentKey = threadKeyOf(thread);
    const open =
      !collapsed &&
      (input.workerFold.get(parentKey) ?? workers.some((worker) => workerNeedsYou(worker)));
    items.push({
      kind: "thread",
      thread,
      section: thread.pinnedAt != null ? "pinned" : "active",
      nested: false,
      lastNested: false,
      workersOpen: workers.length > 0 && !collapsed ? open : null,
    });
    const shown = arrangeStableRows(workers).filter(
      (worker) => open || threadKeyOf(worker) === input.routeThreadKey,
    );
    shown.forEach((worker, index) => {
      items.push({
        kind: "thread",
        thread: worker,
        section: "active",
        nested: true,
        lastNested: index === shown.length - 1,
        workersOpen: null,
      });
    });
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
        items.push({
          kind: "thread",
          thread,
          section,
          nested: false,
          lastNested: false,
          workersOpen: null,
        });
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
