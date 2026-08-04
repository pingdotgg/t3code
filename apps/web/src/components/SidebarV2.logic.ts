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
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";

import { isMacPlatform } from "../lib/utils";
import { isThreadActivelyWorking } from "../session-logic";
import {
  normalizeParentThreadKeys,
  selectVisibleSidebarThreads,
  sidebarThreadKey,
} from "../sidebarThreadTree";
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

interface SidebarV2ThreadNode {
  readonly thread: SidebarThreadSummary;
  readonly threadKey: string;
  readonly children: SidebarV2ThreadNode[];
  readonly status: SidebarV2Status;
  rolledUpStatus: SidebarV2Status;
  descendantCount: number;
  archiveBlocked: boolean;
}

/** Matches the client archive guard: a live agent run or an in-flight session turn. */
export function isSidebarV2ArchiveBlockedThread(
  thread: Pick<SidebarThreadSummary, "session" | "virtualAgentRun">,
): boolean {
  if (thread.virtualAgentRun?.status === "running") {
    return true;
  }
  return thread.session?.status === "running" && thread.session.activeTurnId != null;
}

// Highest urgency first. A collapsed parent adopts the most urgent status in
// its subtree so hiding children never hides work.
const SIDEBAR_V2_STATUS_PRIORITY = ["approval", "input", "working", "failed", "ready"] as const;

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

function buildThreadNodes(threads: readonly SidebarThreadSummary[]): SidebarV2ThreadNode[] {
  const parentByKey = normalizeParentThreadKeys(threads);
  // Sorted once up front so roots and children land in order as they are
  // appended, avoiding a recursive sort pass per subtree.
  const sortedThreads = threads.toSorted(sortByRecent);
  const nodesByKey = new Map<string, SidebarV2ThreadNode>(
    sortedThreads.map((thread) => {
      const threadKey = sidebarThreadKey(thread);
      return [
        threadKey,
        {
          thread,
          threadKey,
          children: [],
          status: resolveSidebarV2Status(thread),
          rolledUpStatus: "ready",
          descendantCount: 0,
          archiveBlocked: false,
        },
      ];
    }),
  );

  const roots: SidebarV2ThreadNode[] = [];
  for (const thread of sortedThreads) {
    const threadKey = sidebarThreadKey(thread);
    const node = nodesByKey.get(threadKey);
    if (!node) continue;
    const parentKey = parentByKey.get(threadKey);
    const parent = parentKey === undefined ? undefined : nodesByKey.get(parentKey);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  resolveNodeRollups(roots);
  return roots;
}

function resolveNodeRollups(nodes: readonly SidebarV2ThreadNode[]): void {
  for (const node of nodes) {
    resolveNodeRollups(node.children);
    node.descendantCount = node.children.reduce(
      (count, child) => count + 1 + child.descendantCount,
      0,
    );
    node.rolledUpStatus = rollUpSidebarV2Status([
      node.status,
      ...node.children.map((child) => child.rolledUpStatus),
    ]);
    node.archiveBlocked =
      isSidebarV2ArchiveBlockedThread(node.thread) ||
      node.children.some((child) => child.archiveBlocked);
  }
}

/**
 * Flattens a subtree into rows. Expansion mirrors sidebar v1: an explicit
 * override wins, the default is "expanded while the subtree has live work",
 * and a routed descendant always stays visible so the open thread can never be
 * collapsed out of view.
 */
function flattenGroupRows(input: {
  readonly nodes: readonly SidebarV2ThreadNode[];
  readonly depth: number;
  readonly activeThreadKey: string | undefined;
  readonly expandedOverrideByThreadKey: ReadonlyMap<string, boolean>;
  readonly output: SidebarV2ThreadRow[];
}): boolean {
  let containsActiveThread = false;
  for (const node of input.nodes) {
    const hasChildren = node.children.length > 0;
    const childRows: SidebarV2ThreadRow[] = [];
    const containsActiveDescendant = hasChildren
      ? flattenGroupRows({
          nodes: node.children,
          depth: input.depth + 1,
          activeThreadKey: input.activeThreadKey,
          expandedOverrideByThreadKey: input.expandedOverrideByThreadKey,
          output: childRows,
        })
      : false;
    const override = input.expandedOverrideByThreadKey.get(node.threadKey);
    const hasActiveDescendant =
      containsActiveDescendant ||
      node.children.some((child) => isSidebarV2ActiveStatus(child.rolledUpStatus));
    const isExpanded =
      hasChildren &&
      (hasActiveDescendant || (override ?? isSidebarV2ActiveStatus(node.rolledUpStatus)));
    input.output.push({
      thread: node.thread,
      threadKey: node.threadKey,
      depth: input.depth,
      hasChildren,
      isExpanded,
      childCount: node.descendantCount,
      displayStatus: node.rolledUpStatus,
      archiveBlocked: node.archiveBlocked,
    });
    if (isExpanded) {
      input.output.push(...childRows);
    }
    containsActiveThread ||= node.threadKey === input.activeThreadKey || containsActiveDescendant;
  }
  return containsActiveThread;
}

function toThreadGroup(
  node: SidebarV2ThreadNode,
  input: {
    readonly activeThreadKey: string | undefined;
    readonly expandedOverrideByThreadKey: ReadonlyMap<string, boolean>;
  },
): SidebarV2ThreadGroup {
  const rows: SidebarV2ThreadRow[] = [];
  flattenGroupRows({
    nodes: [node],
    depth: 0,
    activeThreadKey: input.activeThreadKey,
    expandedOverrideByThreadKey: input.expandedOverrideByThreadKey,
    output: rows,
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

export function classifySidebarV2Shelves(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly now: string;
  readonly pinnedThreadKeysByProjectKey?: PinnedThreadKeysByProjectKey;
  readonly expandedOverrideByThreadKey?: ReadonlyMap<string, boolean>;
  readonly activeThreadKey?: string | undefined;
}): SidebarV2Shelves {
  const visibleThreads = selectVisibleSidebarThreads(input.threads);
  const flattenInput = {
    activeThreadKey: input.activeThreadKey,
    expandedOverrideByThreadKey: input.expandedOverrideByThreadKey ?? NO_EXPANDED_OVERRIDES,
  };
  const rootNodes = buildThreadNodes(visibleThreads);
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
  const sortGroups = (groups: readonly SidebarV2ThreadGroup[]) =>
    groups.toSorted((left, right) => sortByRecent(left.root, right.root));
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
export type SidebarV2Status = "approval" | "input" | "working" | "failed" | "ready";

type SidebarV2StatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session" | "virtualAgentRun"
>;

export function resolveSidebarV2Status(thread: SidebarV2StatusInput): SidebarV2Status {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  // Upstream reads a provider-session phase this fork does not carry, so
  // "working" reuses the same predicate v1's status pill does — including the
  // pre-adoption `connecting` phase, which is work the user is waiting on.
  if (
    thread.virtualAgentRun?.status === "running" ||
    isThreadActivelyWorking(thread.latestTurn, thread.session) ||
    thread.session?.status === "connecting"
  ) {
    return "working";
  }
  if (thread.session?.status === "error") return "failed";
  return "ready";
}

export interface SidebarV2StatusLabel {
  readonly label: "Working" | "Approval" | "Input" | "Failed" | "Done";
  readonly className: string;
  readonly showElapsed: boolean;
}

/**
 * The right-hand label a card row shows at rest. A `ready` thread only earns
 * one while its completion is unseen, so a row the user already read falls
 * back to its relative timestamp instead of shouting "Done" forever.
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
    turn's start (request time until adoption), falling back to the session's
    last transition when the turn projection lags behind. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(turn.startedAt, turn.requestedAt, thread.session?.updatedAt);
  }
  return firstValidTimestamp(thread.session?.updatedAt);
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
