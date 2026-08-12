import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { type OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { sortThreads } from "./lib/threadSort";
import {
  resolveProjectStatusIndicator,
  isActiveThreadStatus,
  type ThreadStatusPill,
} from "./components/Sidebar.logic";
import { deriveAgentRuns, type AgentRun } from "./session-logic";
import type { SidebarThreadSummary } from "./types";

/**
 * Stable key identifying an archived (dismissed) background-agent run. Combines
 * the parent thread id with the run's task id so dismissals survive re-renders
 * and persist across sessions.
 */
export function agentRunDismissKey(
  parentThreadId: SidebarThreadSummary["id"],
  taskId: string,
): string {
  return `agent-run:${parentThreadId}:${taskId}`;
}

export function expandSidebarThreadsWithAgentRuns(input: {
  threads: readonly SidebarThreadSummary[];
  agentRunsByThreadKey: ReadonlyMap<string, readonly AgentRun[]>;
  dismissedAgentRunKeys?: Record<string, true>;
}): SidebarThreadSummary[] {
  const dismissedAgentRunKeys = input.dismissedAgentRunKeys ?? {};
  return input.threads.flatMap((thread) => {
    if (thread.archivedAt !== null) return [thread];

    const threadKey = getThreadKey(thread);
    const agentRuns = input.agentRunsByThreadKey.get(threadKey) ?? thread.backgroundAgentRuns;
    if (!agentRuns?.length) return [thread];

    const visibleAgentRuns = agentRuns.filter(
      (agentRun) => dismissedAgentRunKeys[agentRunDismissKey(thread.id, agentRun.taskId)] !== true,
    );
    if (visibleAgentRuns.length === 0) return [thread];

    return [
      thread,
      ...visibleAgentRuns.map(
        (agentRun): SidebarThreadSummary => ({
          id: ThreadId.make(`agent-run:${thread.id}:${agentRun.taskId}`),
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          parentThreadId: thread.id,
          title: agentRun.name,
          interactionMode: thread.interactionMode,
          session: null,
          createdAt: agentRun.startedAt,
          archivedAt: null,
          updatedAt: agentRun.completedAt ?? agentRun.startedAt,
          latestTurn: null,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasPendingQueuedTurn: false,
          virtualAgentRun: {
            parentThreadId: thread.id,
            taskId: agentRun.taskId,
            status: agentRun.status,
          },
        }),
      ),
    ];
  });
}

export function deriveSidebarThreadsWithAgentRuns(input: {
  threads: readonly SidebarThreadSummary[];
  threadActivities: ReadonlyArray<readonly OrchestrationThreadActivity[]>;
  dismissedAgentRunKeys?: Record<string, true>;
}): SidebarThreadSummary[] {
  const agentRunsByThreadKey = new Map<string, ReturnType<typeof deriveAgentRuns>>();
  for (const [index, thread] of input.threads.entries()) {
    const agentRuns = deriveAgentRuns(input.threadActivities[index] ?? [], undefined);
    if (agentRuns.length > 0) {
      agentRunsByThreadKey.set(getThreadKey(thread), agentRuns);
    }
  }
  return expandSidebarThreadsWithAgentRuns({
    threads: input.threads,
    agentRunsByThreadKey,
    ...(input.dismissedAgentRunKeys ? { dismissedAgentRunKeys: input.dismissedAgentRunKeys } : {}),
  });
}

export function selectVisibleSidebarThreads(
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  const threadByKey = new Map(threads.map((thread) => [getThreadKey(thread), thread] as const));
  const visibilityByKey = new Map<string, boolean>();
  const resolvingKeys = new Set<string>();

  const isVisible = (thread: SidebarThreadSummary): boolean => {
    const threadKey = getThreadKey(thread);
    const cached = visibilityByKey.get(threadKey);
    if (cached !== undefined) {
      return cached;
    }
    if (thread.archivedAt !== null) {
      visibilityByKey.set(threadKey, false);
      return false;
    }
    if (resolvingKeys.has(threadKey)) {
      return true;
    }

    resolvingKeys.add(threadKey);
    const parent =
      thread.parentThreadId === null
        ? undefined
        : threadByKey.get(
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId)),
          );
    const visible = parent === undefined || isVisible(parent);
    resolvingKeys.delete(threadKey);
    visibilityByKey.set(threadKey, visible);
    return visible;
  };

  return threads.filter(isVisible);
}

export function isThreadInSubtree(
  threads: readonly Pick<SidebarThreadSummary, "id" | "parentThreadId">[],
  rootThreadId: SidebarThreadSummary["id"],
  threadId: SidebarThreadSummary["id"],
): boolean {
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const visited = new Set<SidebarThreadSummary["id"]>();
  let candidateId: SidebarThreadSummary["id"] | null = threadId;

  while (candidateId !== null && !visited.has(candidateId)) {
    if (candidateId === rootThreadId) {
      return true;
    }
    visited.add(candidateId);
    candidateId = threadById.get(candidateId)?.parentThreadId ?? null;
  }

  return false;
}

export interface SidebarThreadRowView {
  thread: SidebarThreadSummary;
  threadKey: string;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  childCount: number;
  status: ThreadStatusPill | null;
  rolledUpStatus: ThreadStatusPill | null;
}

export interface SidebarThreadRowsResult {
  rowViews: SidebarThreadRowView[];
  orderedThreadKeys: string[];
  projectStatus: ThreadStatusPill | null;
  statusByThreadKey: ReadonlyMap<string, ThreadStatusPill | null>;
}

interface ThreadTreeNode {
  thread: SidebarThreadSummary;
  threadKey: string;
  children: ThreadTreeNode[];
  status: ThreadStatusPill | null;
  rolledUpStatus: ThreadStatusPill | null;
  descendantCount: number;
}

export interface BuildSidebarThreadRowsInput {
  threads: readonly SidebarThreadSummary[];
  pinnedThreadKeys: readonly string[];
  activeThreadKey?: string | undefined;
  /**
   * Explicit per-thread expand/collapse choices keyed by thread key. When a
   * parent has no entry, expansion falls back to the status-driven default:
   * expanded only while it (or a descendant) is active. An active descendant
   * always remains visible, even after an explicit collapse.
   */
  expandedOverrideByThreadKey: ReadonlyMap<string, boolean>;
  sortOrder: SidebarThreadSortOrder;
  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
}

export function sidebarThreadKey(
  thread: Pick<SidebarThreadSummary, "environmentId" | "id">,
): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

const getThreadKey = sidebarThreadKey;

/**
 * Maps each thread key to its effective parent key, dropping references that
 * would escape the visible set (missing/self parents) or form a cycle so every
 * thread resolves to exactly one root. Keys are environment-scoped so a thread
 * never adopts a same-id parent from another environment.
 */
export function normalizeParentThreadKeys(
  threads: readonly SidebarThreadSummary[],
): Map<string, string> {
  const threadKeys = new Set(threads.map(getThreadKey));
  const parentByKey = new Map<string, string>();

  for (const thread of threads) {
    const threadKey = getThreadKey(thread);
    if (thread.parentThreadId === null) {
      continue;
    }
    const parentKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId));
    if (parentKey === threadKey || !threadKeys.has(parentKey)) {
      continue;
    }
    parentByKey.set(threadKey, parentKey);
  }

  // Deleting only the key currently being visited is safe while iterating.
  for (const threadKey of parentByKey.keys()) {
    const seen = new Set<string>([threadKey]);
    let currentParentKey = parentByKey.get(threadKey);
    while (currentParentKey) {
      if (seen.has(currentParentKey)) {
        parentByKey.delete(threadKey);
        break;
      }
      seen.add(currentParentKey);
      currentParentKey = parentByKey.get(currentParentKey);
    }
  }

  return parentByKey;
}

/** Reorders already-sorted roots so pinned threads lead, preserving pin order. */
function applyPinnedFirst(
  roots: readonly ThreadTreeNode[],
  pinnedThreadKeys: readonly string[],
): ThreadTreeNode[] {
  if (pinnedThreadKeys.length === 0) {
    return [...roots];
  }

  const rootByKey = new Map(roots.map((root) => [root.threadKey, root] as const));
  const pinnedKeySet = new Set(pinnedThreadKeys);
  const emittedKeys = new Set<string>();
  const pinnedRoots = pinnedThreadKeys.flatMap((threadKey) => {
    const root = rootByKey.get(threadKey);
    if (!root || emittedKeys.has(threadKey)) {
      return [];
    }
    emittedKeys.add(threadKey);
    return [root];
  });
  const unpinnedRoots = roots.filter((root) => !pinnedKeySet.has(root.threadKey));
  return [...pinnedRoots, ...unpinnedRoots];
}

function buildTree(input: BuildSidebarThreadRowsInput): {
  roots: ThreadTreeNode[];
  nodesByKey: Map<string, ThreadTreeNode>;
} {
  const parentByKey = normalizeParentThreadKeys(input.threads);
  // Sort once up front so children and roots land in sorted order as they are
  // appended, avoiding a second recursive sort pass.
  const sortedThreads = sortThreads(input.threads, input.sortOrder);
  const nodesByKey = new Map(
    sortedThreads.map((thread) => [
      getThreadKey(thread),
      {
        thread,
        threadKey: getThreadKey(thread),
        children: [] as ThreadTreeNode[],
        status: input.resolveThreadStatus(thread),
        rolledUpStatus: null,
        descendantCount: 0,
      } satisfies ThreadTreeNode,
    ]),
  );

  const roots: ThreadTreeNode[] = [];
  for (const thread of sortedThreads) {
    const threadKey = getThreadKey(thread);
    const node = nodesByKey.get(threadKey);
    if (!node) {
      continue;
    }
    const parentKey = parentByKey.get(threadKey);
    const parent = parentKey ? nodesByKey.get(parentKey) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return { roots: applyPinnedFirst(roots, input.pinnedThreadKeys), nodesByKey };
}

function resolveRollups(nodes: readonly ThreadTreeNode[]): void {
  for (const node of nodes) {
    resolveRollups(node.children);
    node.descendantCount = node.children.reduce(
      (count, child) => count + 1 + child.descendantCount,
      0,
    );
    node.rolledUpStatus = resolveProjectStatusIndicator([
      node.status,
      ...node.children.map((child) => child.rolledUpStatus),
    ]);
  }
}

function flattenRows(input: {
  nodes: readonly ThreadTreeNode[];
  activeThreadKey?: string | undefined;
  expandedOverrideByThreadKey: ReadonlyMap<string, boolean>;
  output: SidebarThreadRowView[];
  depth?: number;
}): boolean {
  const depth = input.depth ?? 0;
  let containsActiveThread = false;
  for (const node of input.nodes) {
    const hasChildren = node.children.length > 0;
    const childRows: SidebarThreadRowView[] = [];
    const containsActiveDescendant = hasChildren
      ? flattenRows({
          nodes: node.children,
          activeThreadKey: input.activeThreadKey,
          expandedOverrideByThreadKey: input.expandedOverrideByThreadKey,
          output: childRows,
          depth: depth + 1,
        })
      : false;
    const override = input.expandedOverrideByThreadKey.get(node.threadKey);
    const hasActiveDescendant =
      containsActiveDescendant ||
      node.children.some((child) => isActiveThreadStatus(child.rolledUpStatus));
    const isExpanded =
      hasChildren &&
      (hasActiveDescendant || (override ?? isActiveThreadStatus(node.rolledUpStatus)));
    input.output.push({
      thread: node.thread,
      threadKey: node.threadKey,
      depth,
      hasChildren,
      isExpanded,
      childCount: node.descendantCount,
      status: node.status,
      rolledUpStatus: node.rolledUpStatus,
    });
    if (isExpanded) {
      input.output.push(...childRows);
    }
    containsActiveThread ||= node.threadKey === input.activeThreadKey || containsActiveDescendant;
  }
  return containsActiveThread;
}

export function buildSidebarThreadRows(
  input: BuildSidebarThreadRowsInput,
): SidebarThreadRowsResult {
  const { roots, nodesByKey } = buildTree(input);
  resolveRollups(roots);

  const rowViews: SidebarThreadRowView[] = [];
  flattenRows({
    nodes: roots,
    activeThreadKey: input.activeThreadKey,
    expandedOverrideByThreadKey: input.expandedOverrideByThreadKey,
    output: rowViews,
  });

  const statusByThreadKey = new Map<string, ThreadStatusPill | null>();
  for (const node of nodesByKey.values()) {
    statusByThreadKey.set(node.threadKey, node.status);
  }

  return {
    rowViews,
    orderedThreadKeys: rowViews.map((rowView) => rowView.threadKey),
    projectStatus: resolveProjectStatusIndicator(roots.map((root) => root.rolledUpStatus)),
    statusByThreadKey,
  };
}

/**
 * Trims flattened rows to a root-thread window, counting only root threads
 * against the limit so expanded children of visible roots stay attached.
 *
 * `requiredThreadKey` must stay rendered even when it sorts below the window,
 * but widening the limit to its ordinal would defeat the window entirely:
 * opening a thread at position 500 would mount 500 roots and every expanded
 * child, and each mounted row installs hooks and store subscriptions. So the
 * limit is fixed and the required thread's root subtree is appended on its
 * own, leaving the number of mounted rows bounded by `rootLimit` plus that one
 * subtree regardless of how deep the thread sits.
 */
export function selectVisibleThreadRows(input: {
  rowViews: readonly SidebarThreadRowView[];
  rootLimit: number;
  requiredThreadKey?: string | null;
}): { rows: readonly SidebarThreadRowView[]; hasOverflow: boolean } {
  const rootLimit = Math.max(input.rootLimit, 0);
  let rootCount = 0;
  // Where the required thread's own root subtree starts, which is the row
  // itself when it is a root and its ancestor root otherwise.
  let requiredRootStart = -1;
  let requiredRootOrdinal = 0;
  let lastRootStart = -1;
  for (let index = 0; index < input.rowViews.length; index += 1) {
    const row = input.rowViews[index]!;
    if (row.depth === 0) {
      rootCount += 1;
      lastRootStart = index;
    }
    if (input.requiredThreadKey != null && row.threadKey === input.requiredThreadKey) {
      requiredRootStart = lastRootStart;
      requiredRootOrdinal = rootCount;
    }
  }

  if (rootCount <= rootLimit) {
    return { rows: input.rowViews, hasOverflow: false };
  }

  const rows: SidebarThreadRowView[] = [];
  let visibleRootCount = 0;
  for (const row of input.rowViews) {
    if (row.depth === 0) {
      visibleRootCount += 1;
      if (visibleRootCount > rootLimit) {
        break;
      }
    }
    rows.push(row);
  }

  if (requiredRootStart >= 0 && requiredRootOrdinal > rootLimit) {
    for (let index = requiredRootStart; index < input.rowViews.length; index += 1) {
      const row = input.rowViews[index]!;
      if (index > requiredRootStart && row.depth === 0) {
        break;
      }
      rows.push(row);
    }
  }

  return { rows, hasOverflow: true };
}
