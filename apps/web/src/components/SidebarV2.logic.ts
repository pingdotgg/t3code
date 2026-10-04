import {
  type ExecutionEnvironmentDescriptor,
  type PinnedThreadKeysByProjectKey,
  type ThreadId,
} from "@t3tools/contracts";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveThreadSemanticStatus,
  type ThreadSemanticStatus,
} from "@t3tools/client-runtime/state/thread-status";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";

import { isMacPlatform } from "../lib/utils";
import { selectVisibleSidebarThreads, sidebarThreadKey } from "../sidebarThreadTree";
import {
  buildThreadTree,
  flattenThreadTree,
  type ThreadTreeNode,
} from "@t3tools/client-runtime/state/thread-hierarchy";
import type { SidebarThreadSummary } from "../types";

export type ThreadLifecycleSupport = {
  readonly settlement: boolean;
  readonly snooze: boolean;
};

export function shouldReserveMacSidebarChrome({
  isElectron,
  platform,
}: {
  readonly isElectron: boolean;
  readonly platform: string;
}): boolean {
  return isElectron && isMacPlatform(platform);
}

/**
 * Lifecycle capabilities are resolved per environment rather than reduced to a
 * single flag for the whole sidebar: an environment whose server predates
 * thread.settle/snooze must degrade only its own rows, not disable the inbox
 * for every other environment's threads.
 */
export function resolveThreadLifecycleSupport(
  descriptors: readonly (ExecutionEnvironmentDescriptor | null | undefined)[],
): ReadonlyMap<string, ThreadLifecycleSupport> {
  const byEnvironment = new Map<string, ThreadLifecycleSupport>();
  for (const descriptor of descriptors) {
    if (!descriptor) continue;
    byEnvironment.set(descriptor.environmentId, {
      settlement: descriptor.capabilities.threadSettlement === true,
      snooze: descriptor.capabilities.threadSnooze === true,
    });
  }
  return byEnvironment;
}

/**
 * Bulk shelf actions fan out to one command per thread, so they must offer only
 * threads that can actually accept it. An unsupported environment or
 * blocked-on-you work is rejected server-side, which would half-apply the
 * action and report a failure the user cannot act on.
 */
export function selectSnoozeShelfBulkTargets({
  snoozed,
  lifecycleSupport,
  now,
}: {
  readonly snoozed: readonly SidebarThreadSummary[];
  readonly lifecycleSupport: ReadonlyMap<string, ThreadLifecycleSupport>;
  readonly now: string;
}): {
  readonly wakeable: readonly SidebarThreadSummary[];
  readonly reschedulable: readonly SidebarThreadSummary[];
} {
  const wakeable = snoozed.filter(
    (thread) => lifecycleSupport.get(thread.environmentId)?.snooze === true,
  );
  return {
    wakeable,
    reschedulable: wakeable.filter((thread) => canSnooze(thread, { now })),
  };
}

function sortByRecent(left: SidebarThreadSummary, right: SidebarThreadSummary): number {
  const leftAt = left.updatedAt ?? left.createdAt;
  const rightAt = right.updatedAt ?? right.createdAt;
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? 1 : -1;
  }
  return left.title.localeCompare(right.title);
}

/**
 * A row in a nested-chat group. Nested rows render title-only, so `displayStatus`
 * always rolls up the subtree — expanding a parent must not be the only way to
 * learn that a nested chat is blocked on the user.
 */
export interface SidebarV2ThreadRow {
  readonly thread: SidebarThreadSummary;
  readonly threadKey: string;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  /** Total descendants, used for the expand affordance's label. */
  readonly childCount: number;
  readonly displayStatus: SidebarV2Status;
  /**
   * True when this thread or any active descendant is mid-turn. Archive walks
   * the whole subtree server-side, so a quiet parent with a running child must
   * still disable the control.
   */
  readonly archiveBlocked: boolean;
}

/** A root thread plus its visible descendants. `rows[0]` is always the root. */
export interface SidebarV2ThreadGroup {
  readonly root: SidebarThreadSummary;
  readonly rootKey: string;
  readonly rows: readonly SidebarV2ThreadRow[];
}

type SidebarV2ThreadNode = ThreadTreeNode<SidebarThreadSummary, SidebarV2Status>;

/** Matches the client archive guard: a live agent run or an in-flight session turn. */
export function isSidebarV2ArchiveBlockedThread(
  thread: Pick<SidebarThreadSummary, "session" | "virtualAgentRun" | "hasPendingQueuedTurn">,
): boolean {
  if (thread.virtualAgentRun?.status === "running") {
    return true;
  }
  if (thread.hasPendingQueuedTurn) {
    return true;
  }
  return thread.session?.status === "running" && thread.session.activeTurnId != null;
}

// Highest urgency first. A collapsed parent adopts the most urgent status in
// its subtree so hiding children never hides work.
const SIDEBAR_V2_STATUS_PRIORITY = [
  "approval",
  "input",
  "working",
  "connecting",
  "failed",
  "ready",
] as const;

export function rollUpSidebarV2Status(statuses: readonly SidebarV2Status[]): SidebarV2Status {
  let resolved: SidebarV2Status = "ready";
  let resolvedRank = SIDEBAR_V2_STATUS_PRIORITY.indexOf(resolved);
  for (const status of statuses) {
    const rank = SIDEBAR_V2_STATUS_PRIORITY.indexOf(status);
    if (rank < resolvedRank) {
      resolved = status;
      resolvedRank = rank;
    }
  }
  return resolved;
}

/** Anything but the resting state: drives both shelf promotion and the
    default expansion of a parent whose subtree still has live work. */
export function isSidebarV2ActiveStatus(status: SidebarV2Status): boolean {
  return status !== "ready";
}

function buildThreadNodes(
  threads: readonly SidebarThreadSummary[],
  pendingThreadKeys: ReadonlySet<string>,
): SidebarV2ThreadNode[] {
  return buildThreadTree({
    threads,
    compare: sortByRecent,
    resolveStatus: (thread) =>
      resolveSidebarV2Status({
        ...thread,
        hasPendingTurn: pendingThreadKeys.has(sidebarThreadKey(thread)),
      }),
    rollUpStatus: rollUpSidebarV2Status,
    isArchiveBlocked: isSidebarV2ArchiveBlockedThread,
  });
}

function toThreadGroup(
  node: SidebarV2ThreadNode,
  input: {
    readonly activeThreadKey: string | undefined;
    readonly expandedOverrideByThreadKey: ReadonlyMap<string, boolean>;
  },
): SidebarV2ThreadGroup {
  const rows = flattenThreadTree({
    nodes: [node],
    activeThreadKey: input.activeThreadKey,
    expandedOverrideByThreadKey: input.expandedOverrideByThreadKey,
    isActiveStatus: isSidebarV2ActiveStatus,
  });
  return { root: node.thread, rootKey: node.threadKey, rows };
}

const NO_EXPANDED_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

export interface SidebarV2Shelves {
  readonly pinned: readonly SidebarV2ThreadGroup[];
  readonly pinnedByProjectKey: ReadonlyMap<string, readonly SidebarV2ThreadGroup[]>;
  readonly active: readonly SidebarV2ThreadGroup[];
  readonly snoozed: readonly SidebarV2ThreadGroup[];
  readonly settled: readonly SidebarV2ThreadGroup[];
}

export function resolveSettledThreadVisibility(input: {
  readonly settled: readonly SidebarV2ThreadGroup[];
  readonly visibleCount: number;
  readonly showAll: boolean;
  readonly activeThreadKey: string | null;
}): { readonly groups: readonly SidebarV2ThreadGroup[]; readonly remainingCount: number } {
  const groups = input.showAll ? input.settled : input.settled.slice(0, input.visibleCount);
  const containsActiveThread = (group: SidebarV2ThreadGroup) =>
    group.rows.some((row) => row.threadKey === input.activeThreadKey);

  if (input.activeThreadKey !== null && !groups.some(containsActiveThread)) {
    const activeGroup = input.settled.find(containsActiveThread);
    if (activeGroup) {
      const visibleGroups = [...groups, activeGroup];
      return {
        groups: visibleGroups,
        remainingCount: Math.max(0, input.settled.length - visibleGroups.length),
      };
    }
  }

  return {
    groups,
    remainingCount: Math.max(0, input.settled.length - groups.length),
  };
}

export function classifySidebarV2Shelves(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly now: string;
  readonly pinnedThreadKeysByProjectKey?: PinnedThreadKeysByProjectKey;
  readonly expandedOverrideByThreadKey?: ReadonlyMap<string, boolean>;
  readonly activeThreadKey?: string | undefined;
  readonly pendingThreadKeys?: ReadonlySet<string>;
}): SidebarV2Shelves {
  const visibleThreads = selectVisibleSidebarThreads(input.threads);
  const flattenInput = {
    activeThreadKey: input.activeThreadKey,
    expandedOverrideByThreadKey: input.expandedOverrideByThreadKey ?? NO_EXPANDED_OVERRIDES,
  };
  const rootNodes = buildThreadNodes(visibleThreads, input.pendingThreadKeys ?? new Set());
  // Only roots are pinnable: a nested chat rides along with its parent, so a
  // stale pin on a thread that has since become a child is ignored.
  const groupByRootKey = new Map(
    rootNodes
      .filter((node) => node.thread.virtualAgentRun === undefined)
      .map((node) => [node.threadKey, node] as const),
  );

  const pinnedByProjectKey = new Map<string, readonly SidebarV2ThreadGroup[]>();
  const pinnedThreadKeys = new Set<string>();
  for (const [projectKey, threadKeys] of Object.entries(input.pinnedThreadKeysByProjectKey ?? {})) {
    const pinnedGroups = threadKeys.flatMap((threadKey) => {
      const node = groupByRootKey.get(threadKey);
      return node &&
        scopedProjectKey(scopeProjectRef(node.thread.environmentId, node.thread.projectId)) ===
          projectKey
        ? [toThreadGroup(node, flattenInput)]
        : [];
    });
    if (pinnedGroups.length > 0) {
      pinnedByProjectKey.set(projectKey, pinnedGroups);
      for (const group of pinnedGroups) {
        pinnedThreadKeys.add(group.rootKey);
      }
    }
  }

  const active: SidebarV2ThreadGroup[] = [];
  const snoozed: SidebarV2ThreadGroup[] = [];
  const settled: SidebarV2ThreadGroup[] = [];
  for (const node of rootNodes) {
    if (pinnedThreadKeys.has(node.threadKey)) {
      continue;
    }
    const group = toThreadGroup(node, flattenInput);
    // The whole subtree lands wherever its root does, so a nested chat never
    // detaches from its parent. Promote only for live *descendants* first: the
    // root's own working status must not defeat an intentional snooze (canSnooze
    // allows active work). After that, honor the root's snooze/settled state
    // before falling back to its own status.
    const hasActiveDescendant = node.children.some((child) =>
      isSidebarV2ActiveStatus(child.rolledUpStatus),
    );
    if (hasActiveDescendant) {
      active.push(group);
    } else if (effectiveSnoozed(node.thread, { now: input.now })) {
      snoozed.push(group);
    } else if (isSidebarV2ActiveStatus(node.status)) {
      active.push(group);
    } else if (effectiveSettled(node.thread, { now: input.now })) {
      settled.push(group);
    } else {
      active.push(group);
    }
  }
  const mostRecentThreadByRootKey = new Map(
    rootNodes.map((node) => [node.threadKey, node.mostRecentThread] as const),
  );
  const sortGroups = (groups: readonly SidebarV2ThreadGroup[]) =>
    groups.toSorted((left, right) =>
      sortByRecent(
        mostRecentThreadByRootKey.get(left.rootKey) ?? left.root,
        mostRecentThreadByRootKey.get(right.rootKey) ?? right.root,
      ),
    );
  return {
    pinned: [...pinnedByProjectKey.values()].flat(),
    pinnedByProjectKey,
    active: sortGroups(active),
    snoozed: sortGroups(snoozed),
    settled: sortGroups(settled),
  };
}

export function resolveSidebarV2ThreadRouteTarget(
  thread: Pick<SidebarThreadSummary, "id" | "virtualAgentRun">,
): {
  readonly threadId: ThreadId;
  readonly agentTaskId: string | null;
} {
  const agentRun = thread.virtualAgentRun;
  return agentRun
    ? { threadId: agentRun.parentThreadId, agentTaskId: agentRun.taskId }
    : { threadId: thread.id, agentTaskId: null };
}

// ── Sidebar v2 status model ─────────────────────────────────────────
// Five visual states resolved in strict priority order. Colour is reserved
// for "act now" (approval), "answer me" (input), "in motion" (working) and
// "broken" (failed); ready is the resting state a card labels as Done once
// its completion has not been seen yet.
export type SidebarV2Status = Exclude<ThreadSemanticStatus, "plan-ready" | "completed">;

type SidebarV2StatusInput = Pick<
  SidebarThreadSummary,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasPendingQueuedTurn"
  | "latestTurn"
  | "session"
  | "virtualAgentRun"
> & {
  readonly hasPendingTurn?: boolean;
};

export function resolveSidebarV2Status(thread: SidebarV2StatusInput): SidebarV2Status {
  const semanticStatus = resolveThreadSemanticStatus({
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasPendingQueuedTurn: thread.hasPendingQueuedTurn,
    hasPendingTurn: thread.hasPendingTurn,
    latestTurn: thread.latestTurn,
    session: thread.session,
    virtualAgentRun: thread.virtualAgentRun,
  });
  return semanticStatus === "plan-ready" || semanticStatus === "completed"
    ? "ready"
    : semanticStatus;
}

export interface SidebarV2StatusLabel {
  readonly label: "Working" | "Connecting" | "Approval" | "Input" | "Failed" | "Done";
  readonly className: string;
  readonly showElapsed: boolean;
}

/**
 * The right-hand label a card row shows at rest. A `ready` thread only earns
 * one while its own completion is unseen, so a row the user
 * already read falls back to its relative timestamp.
 */
export function resolveSidebarV2StatusLabel(input: {
  readonly status: SidebarV2Status;
  readonly unseenCompletion: boolean;
}): SidebarV2StatusLabel | null {
  switch (input.status) {
    case "working":
      return {
        label: "Working",
        className: "text-sky-600 dark:text-sky-400",
        showElapsed: true,
      };
    case "connecting":
      return {
        label: "Connecting",
        className: "text-sky-600 dark:text-sky-400",
        showElapsed: false,
      };
    case "approval":
      return {
        label: "Approval",
        className: "text-amber-700 dark:text-amber-300",
        showElapsed: false,
      };
    case "input":
      return {
        label: "Input",
        className: "text-indigo-600 dark:text-indigo-300",
        showElapsed: false,
      };
    case "failed":
      return {
        label: "Failed",
        className: "text-red-700 dark:text-red-300",
        showElapsed: false,
      };
    case "ready":
      return input.unseenCompletion
        ? {
            label: "Done",
            className: "text-emerald-700 dark:text-emerald-300",
            showElapsed: false,
          }
        : null;
  }
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate. */
export function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

/** The timestamp a working thread's elapsed label counts from: the running
    turn's start (request time until adoption), then the session's last
    transition, then `createdAt`. Synthetic background-agent rows set
    `session`/`latestTurn` to null and store the run start in `createdAt`. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "session" | "createdAt">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(
      turn.startedAt,
      turn.requestedAt,
      thread.session?.updatedAt,
      thread.createdAt,
    );
  }
  return firstValidTimestamp(thread.session?.updatedAt, thread.createdAt);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Sidebar rows are narrow and every row carries a timestamp, so the shared
 * "3m ago" phrasing spends horizontal space on a word that is identical on
 * every row. The suffix is dropped rather than reworded because the column
 * position already says "when".
 */
export function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -" ago".length) : label;
}
