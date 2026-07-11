import type {
  SidebarThreadSortOrder,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { sortThreads, type ThreadSortInput } from "./threadSort.ts";

export type SubagentThreadTreeInput = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage"
> &
  ThreadSortInput;

export interface SubagentThreadTreeRow<
  Thread extends SubagentThreadTreeInput = SubagentThreadTreeInput,
> {
  readonly thread: Thread;
  readonly depth: number;
  readonly hasSubagentChildren: boolean;
  readonly isSubagentBranchExpanded: boolean;
}

export function isSubagentThread(thread: Pick<SubagentThreadTreeInput, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

export function subagentThreadKey(
  thread: Pick<SubagentThreadTreeInput, "environmentId" | "id">,
): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function subagentParentThreadKey(thread: SubagentThreadTreeInput): string | null {
  if (!isSubagentThread(thread)) return null;
  const parentThreadId = thread.lineage.parentThreadId;
  return parentThreadId === null
    ? null
    : scopedThreadKey(scopeThreadRef(thread.environmentId, parentThreadId));
}

/**
 * Identifies recovery roots whose declared subagent parent is not present in
 * the supplied shell view (for example because it is deleted or archived).
 */
export function hasUnavailableSubagentParent<Thread extends SubagentThreadTreeInput>(
  threads: readonly Thread[],
  thread: Thread,
): boolean {
  const parentKey = subagentParentThreadKey(thread);
  return (
    parentKey !== null && !threads.some((candidate) => subagentThreadKey(candidate) === parentKey)
  );
}

/**
 * Returns the transitive set of threads owned by `root` through subagent
 * lineage. Forks and context-transfer relationships are intentionally not
 * ownership edges and are therefore never included. Malformed cycles are
 * bounded by the visited set.
 */
export function getOwnedSubagentDescendants<Thread extends SubagentThreadTreeInput>(
  threads: readonly Thread[],
  root: Pick<Thread, "environmentId" | "id">,
): readonly Thread[] {
  const childrenByParentKey = new Map<string, Thread[]>();
  for (const thread of threads) {
    const parentKey = subagentParentThreadKey(thread);
    if (parentKey === null) continue;
    const children = childrenByParentKey.get(parentKey);
    if (children === undefined) childrenByParentKey.set(parentKey, [thread]);
    else children.push(thread);
  }

  const rootKey = subagentThreadKey(root);
  const visited = new Set<string>([rootKey]);
  const descendants: Thread[] = [];
  const pending = [...(childrenByParentKey.get(rootKey) ?? [])];
  while (pending.length > 0) {
    const thread = pending.shift();
    if (thread === undefined) continue;
    const key = subagentThreadKey(thread);
    if (visited.has(key)) continue;
    visited.add(key);
    descendants.push(thread);
    pending.push(...(childrenByParentKey.get(key) ?? []));
  }
  return descendants;
}

/** Returns `root` followed by every recursively owned subagent descendant. */
export function getOwnedSubagentSubtree<Thread extends SubagentThreadTreeInput>(
  threads: readonly Thread[],
  root: Thread,
): readonly Thread[] {
  return [root, ...getOwnedSubagentDescendants(threads, root)];
}

export type ThreadSubtreeAction = "archive" | "unarchive" | "delete";

export interface ThreadSubtreeActionCopy {
  readonly title: string;
  readonly message: string;
  readonly confirmText: "Archive" | "Unarchive" | "Delete";
}

/**
 * Shared action copy keeps web and mobile explicit about recursive ownership
 * semantics. `descendantCount` excludes the selected root thread.
 */
export function threadSubtreeActionCopy(input: {
  readonly action: ThreadSubtreeAction;
  readonly threadTitle: string;
  readonly descendantCount: number;
  readonly activeThreadCount?: number;
}): ThreadSubtreeActionCopy {
  const count = Math.max(0, input.descendantCount);
  const activeCount = Math.max(0, input.activeThreadCount ?? 0);
  const childLabel = `${count} subagent thread${count === 1 ? "" : "s"}`;
  const quotedTitle = `“${input.threadTitle}”`;
  const activeWarning =
    activeCount === 0 || input.action === "unarchive"
      ? ""
      : ` Active work in ${activeCount} thread${activeCount === 1 ? "" : "s"} will be cancelled.`;

  switch (input.action) {
    case "archive":
      return {
        title: count === 0 ? "Archive thread?" : `Archive thread and ${childLabel}?`,
        message:
          count === 0
            ? `${quotedTitle} will be moved to the archive.${activeWarning}`
            : `${quotedTitle} and its ${childLabel} will be moved to the archive.${activeWarning}`,
        confirmText: "Archive",
      };
    case "unarchive":
      return {
        title: count === 0 ? "Unarchive thread?" : `Unarchive thread and ${childLabel}?`,
        message:
          count === 0
            ? `${quotedTitle} will be restored.`
            : `${quotedTitle} and its ${childLabel} archived with it will be restored.`,
        confirmText: "Unarchive",
      };
    case "delete":
      return {
        title: count === 0 ? "Delete thread?" : `Delete thread and ${childLabel}?`,
        message:
          count === 0
            ? `${quotedTitle} will be permanently deleted, including its conversation and terminal history.${activeWarning}`
            : `${quotedTitle} and its ${childLabel} will be permanently deleted, including their conversation and terminal history.${activeWarning}`,
        confirmText: "Delete",
      };
  }
}

function indexSubagentThreads<Thread extends SubagentThreadTreeInput>(threads: readonly Thread[]) {
  const threadKeys = new Set(threads.map(subagentThreadKey));
  const childrenByParentKey = new Map<string, Thread[]>();
  for (const thread of threads) {
    const parentKey = subagentParentThreadKey(thread);
    if (parentKey === null || !threadKeys.has(parentKey)) continue;
    const children = childrenByParentKey.get(parentKey);
    if (children === undefined) childrenByParentKey.set(parentKey, [thread]);
    else children.push(thread);
  }
  return { threadKeys, childrenByParentKey } as const;
}

/**
 * Returns every subagent ancestor needed to reveal `threadKey` in a collapsed
 * tree. Scoped keys prevent same-named threads in different environments from
 * being joined. Malformed cycles stop at the first repeated node.
 */
export function getSubagentThreadAncestorKeys<Thread extends SubagentThreadTreeInput>(
  threads: readonly Thread[],
  threadKey: string | null,
): ReadonlySet<string> {
  if (threadKey === null) return new Set();

  const threadByKey = new Map(
    threads.map((thread) => [subagentThreadKey(thread), thread] as const),
  );
  const rootKeys = new Set(getSubagentThreadTreeRoots(threads).map(subagentThreadKey));
  const ancestors = new Set<string>();
  const visited = new Set<string>([threadKey]);
  let current = threadByKey.get(threadKey);

  while (current !== undefined) {
    if (rootKeys.has(subagentThreadKey(current))) break;
    const parentKey = subagentParentThreadKey(current);
    if (parentKey === null || visited.has(parentKey)) break;
    const parent = threadByKey.get(parentKey);
    if (parent === undefined) break;
    ancestors.add(parentKey);
    visited.add(parentKey);
    current = parent;
  }

  return ancestors;
}

/**
 * Selects roots for the nested subagent presentation. Forks remain top-level.
 * Orphans are roots. If malformed lineage forms a rootless cycle, the first
 * unplaced thread becomes a deterministic synthetic root so every thread stays
 * visible exactly once.
 */
export function getSubagentThreadTreeRoots<Thread extends SubagentThreadTreeInput>(
  threads: readonly Thread[],
): readonly Thread[] {
  const { threadKeys, childrenByParentKey } = indexSubagentThreads(threads);

  const roots = threads.filter((thread) => {
    const parentKey = subagentParentThreadKey(thread);
    return parentKey === null || !threadKeys.has(parentKey);
  });
  const placedKeys = new Set<string>();
  const markPlaced = (thread: Thread) => {
    const key = subagentThreadKey(thread);
    if (placedKeys.has(key)) return;
    placedKeys.add(key);
    for (const child of childrenByParentKey.get(key) ?? []) markPlaced(child);
  };
  for (const root of roots) markPlaced(root);
  for (const thread of threads) {
    if (placedKeys.has(subagentThreadKey(thread))) continue;
    roots.push(thread);
    markPlaced(thread);
  }
  return roots;
}

export function flattenSubagentThreadTree<Thread extends SubagentThreadTreeInput>(input: {
  readonly threads: readonly Thread[];
  readonly roots: readonly Thread[];
  readonly expandedThreadKeys: ReadonlySet<string>;
  readonly threadSortOrder: SidebarThreadSortOrder;
}): readonly SubagentThreadTreeRow<Thread>[] {
  const { childrenByParentKey } = indexSubagentThreads(input.threads);

  for (const [parentKey, children] of childrenByParentKey) {
    childrenByParentKey.set(parentKey, sortThreads(children, input.threadSortOrder));
  }

  const rows: SubagentThreadTreeRow<Thread>[] = [];
  const visited = new Set<string>();
  const visit = (thread: Thread, depth: number) => {
    const key = subagentThreadKey(thread);
    if (visited.has(key)) return;
    visited.add(key);
    const children = (childrenByParentKey.get(key) ?? []).filter(
      (child) => !visited.has(subagentThreadKey(child)),
    );
    const hasSubagentChildren = children.length > 0;
    const isSubagentBranchExpanded = hasSubagentChildren && input.expandedThreadKeys.has(key);
    rows.push({ thread, depth, hasSubagentChildren, isSubagentBranchExpanded });
    if (!isSubagentBranchExpanded) return;
    for (const child of children) visit(child, depth + 1);
  };

  for (const root of input.roots) visit(root, 0);
  return rows;
}

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "transfer";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    input.threads.map(
      (thread) => [thread.id, { threadId: thread.id, thread, missing: false }] as const,
    ),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(edgeKey(edge), edge);
  };

  for (const thread of input.threads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: thread.status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status: subagent.status,
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function relatedThreadIds(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const edge of graph.edges) {
    if (edge.sourceThreadId === threadId) ids.add(edge.targetThreadId);
    if (edge.targetThreadId === threadId) ids.add(edge.sourceThreadId);
  }
  return [...ids];
}

export function walkThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>([threadId]);
  const pending: Array<{ readonly threadId: ThreadId; readonly depth: number }> = [
    { threadId, depth: 0 },
  ];
  const rows: ThreadRelationshipWalkRow[] = [];

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined) continue;
    for (const edge of graph.edges) {
      const relatedId =
        edge.sourceThreadId === current.threadId
          ? edge.targetThreadId
          : edge.targetThreadId === current.threadId
            ? edge.sourceThreadId
            : null;
      if (relatedId === null || visited.has(relatedId)) continue;
      visited.add(relatedId);
      const depth = current.depth + 1;
      rows.push({ threadId: relatedId, fromThreadId: current.threadId, depth, edge });
      pending.push({ threadId: relatedId, depth });
    }
  }

  return rows;
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}
