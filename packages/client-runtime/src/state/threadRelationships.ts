import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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

export interface ChildAgentDisplayState {
  readonly status: OrchestrationV2Subagent["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}

/** Shell status is the child's latest run status; `idle` means it has no runs. */
function subagentStatusFromShellStatus(
  status: OrchestrationV2ThreadShell["status"],
): OrchestrationV2Subagent["status"] | null {
  switch (status) {
    case "preparing":
    case "starting":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "queued":
      return "pending";
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "rolled_back":
      return "cancelled";
    case "idle":
      return null;
  }
}

/**
 * Status and timing to show for a child agent in Lineage.
 *
 * The parent's subagent record is the original delegated task. Once its result
 * is published the server keeps that status, result, and timestamps, even when
 * the child thread later takes follow-up turns. The child shell is the live
 * thread, so for an app-owned child with a shell its activity run (or latest
 * run) decides the status and the timer anchors. Provider-native subagents and
 * children without a shell keep the record. The record's result stays the
 * delegated task's history either way.
 */
export function resolveChildAgentDisplayState(input: {
  readonly subagent: Pick<
    OrchestrationV2Subagent,
    "origin" | "status" | "startedAt" | "completedAt"
  >;
  readonly childThread: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "activityRunStatus"
    | "activityRunStartedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
  > | null;
}): ChildAgentDisplayState {
  const { subagent, childThread } = input;
  const record: ChildAgentDisplayState = {
    status: subagent.status,
    startedAt: subagent.startedAt,
    completedAt: subagent.completedAt,
  };
  if (subagent.origin !== "app_owned" || childThread === null) return record;
  const activityRunStatus = childThread.activityRunStatus ?? null;
  if (activityRunStatus !== null) {
    // Preparing and starting count as running so the timer ticks from the
    // activity run's anchor, the same anchor the sidebar working timer uses.
    return {
      status: activityRunStatus === "waiting" ? "waiting" : "running",
      startedAt: childThread.activityRunStartedAt ?? subagent.startedAt,
      completedAt: null,
    };
  }
  const status = subagentStatusFromShellStatus(childThread.status);
  if (status === null) return record;
  // A queued follow-up has not started, so there is nothing to time yet.
  if (status === "pending") return { status, startedAt: null, completedAt: null };
  return {
    status,
    startedAt: childThread.latestRunStartedAt ?? subagent.startedAt,
    completedAt: childThread.latestRunCompletedAt ?? subagent.completedAt,
  };
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
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

  for (const thread of threads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: thread.activityRunStatus ?? thread.status,
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
        status: resolveChildAgentDisplayState({
          subagent,
          childThread: threadsById.get(subagent.childThreadId) ?? null,
        }).status,
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

/** True when `edge` reaches `currentThreadId` from its parent or owning agent. */
export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  // `createdAt` is typed as a DateTime, but the value reaches here from a
  // decoded shell that may be missing (a related thread we have no shell for).
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Orders the web thread-details Lineage rows for display.
 *
 * Web-specific by design: the panel pins the parent row first and a distinct
 * merge-back target second so their actions stay where the user expects, and
 * only then falls back to newest-created-first. Mobile does not share that
 * exception, so this is not the canonical relationship order and should not be
 * reused as one.
 *
 * Ordering below the pins is `createdAt` descending, which is immutable, so
 * rows never move when messages or status changes arrive on a related thread.
 * Threads whose shell is missing (or whose `createdAt` did not decode) sink to
 * the bottom. Ties break by thread id ascending so the order is total.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}
