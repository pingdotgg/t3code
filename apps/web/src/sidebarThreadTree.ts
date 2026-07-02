import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { sortThreads } from "./lib/threadSort";
import { resolveProjectStatusIndicator, type ThreadStatusPill } from "./components/Sidebar.logic";
import type { SidebarThreadSummary } from "./types";

export interface SidebarThreadRowView {
  thread: SidebarThreadSummary;
  threadKey: string;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  childCount: number;
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
  collapsedThreadKeys: ReadonlySet<string>;
  sortOrder: SidebarThreadSortOrder;
  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
}

function getThreadKey(thread: SidebarThreadSummary): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/**
 * Maps each thread to its effective parent, dropping references that would
 * escape the visible set (missing/self parents) or form a cycle so every
 * thread resolves to exactly one root.
 */
function normalizeParentById(
  threads: readonly SidebarThreadSummary[],
): Map<SidebarThreadSummary["id"], SidebarThreadSummary["id"]> {
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const parentById = new Map<SidebarThreadSummary["id"], SidebarThreadSummary["id"]>();

  for (const thread of threads) {
    const parentId = thread.parentThreadId ?? null;
    if (parentId === null || parentId === thread.id || !threadById.has(parentId)) {
      continue;
    }
    parentById.set(thread.id, parentId);
  }

  for (const thread of threads) {
    const seen = new Set<SidebarThreadSummary["id"]>([thread.id]);
    let currentParentId = parentById.get(thread.id);
    while (currentParentId) {
      if (seen.has(currentParentId)) {
        parentById.delete(thread.id);
        break;
      }
      seen.add(currentParentId);
      currentParentId = parentById.get(currentParentId);
    }
  }

  return parentById;
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
  nodeById: Map<SidebarThreadSummary["id"], ThreadTreeNode>;
} {
  const parentById = normalizeParentById(input.threads);
  // Sort once up front so children and roots land in sorted order as they are
  // appended, avoiding a second recursive sort pass.
  const sortedThreads = sortThreads(input.threads, input.sortOrder);
  const nodeById = new Map(
    sortedThreads.map((thread) => [
      thread.id,
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
    const node = nodeById.get(thread.id);
    if (!node) {
      continue;
    }
    const parentId = parentById.get(thread.id);
    const parent = parentId ? nodeById.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return { roots: applyPinnedFirst(roots, input.pinnedThreadKeys), nodeById };
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
  collapsedThreadKeys: ReadonlySet<string>;
  output: SidebarThreadRowView[];
  depth?: number;
}): void {
  const depth = input.depth ?? 0;
  for (const node of input.nodes) {
    const hasChildren = node.children.length > 0;
    const isExpanded = hasChildren && !input.collapsedThreadKeys.has(node.threadKey);
    input.output.push({
      thread: node.thread,
      threadKey: node.threadKey,
      depth,
      hasChildren,
      isExpanded,
      childCount: node.descendantCount,
      rolledUpStatus: node.rolledUpStatus,
    });
    if (isExpanded) {
      flattenRows({
        nodes: node.children,
        collapsedThreadKeys: input.collapsedThreadKeys,
        output: input.output,
        depth: depth + 1,
      });
    }
  }
}

export function buildSidebarThreadRows(
  input: BuildSidebarThreadRowsInput,
): SidebarThreadRowsResult {
  const { roots, nodeById } = buildTree(input);
  resolveRollups(roots);

  const rowViews: SidebarThreadRowView[] = [];
  flattenRows({ nodes: roots, collapsedThreadKeys: input.collapsedThreadKeys, output: rowViews });

  const statusByThreadKey = new Map<string, ThreadStatusPill | null>();
  for (const node of nodeById.values()) {
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
 * Trims flattened rows to the preview window, counting only root threads
 * against the limit so expanded children of visible roots stay attached.
 */
export function selectVisibleThreadRows(input: {
  rowViews: readonly SidebarThreadRowView[];
  isThreadListExpanded: boolean;
  previewLimit: number;
}): { rows: SidebarThreadRowView[]; hasOverflow: boolean } {
  const rootCount = input.rowViews.reduce((count, row) => (row.depth === 0 ? count + 1 : count), 0);
  const hasOverflow = rootCount > input.previewLimit;
  if (input.isThreadListExpanded || !hasOverflow) {
    return { rows: [...input.rowViews], hasOverflow };
  }

  const rows: SidebarThreadRowView[] = [];
  let visibleRootCount = 0;
  for (const row of input.rowViews) {
    if (row.depth === 0) {
      visibleRootCount += 1;
    }
    if (visibleRootCount > input.previewLimit) {
      break;
    }
    rows.push(row);
  }
  return { rows, hasOverflow };
}
