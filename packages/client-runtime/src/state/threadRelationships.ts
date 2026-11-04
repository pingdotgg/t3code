import {
  isOrchestrationV2WorkActive,
  isSideChatThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell } from "./models.ts";

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
  // A T3 Learn side chat is a fork of its parent, but it hands back through Done, not Merge back.
  if (
    projection?.thread.lineage.relationshipToParent !== "fork" ||
    isSideChatThread(projection.thread)
  ) {
    return null;
  }
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
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  const selectedThread = input.projection?.thread;
  const lineageThreads =
    selectedThread !== undefined && !threadsById.has(selectedThread.id)
      ? [...threads, { ...selectedThread, activityRunStatus: null, status: null }]
      : threads;
  for (const thread of lineageThreads) {
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
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status:
          child?.activityRunStatus ??
          (child?.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status)
            ? child.status
            : subagent.status),
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

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web pins the parent and distinct merge-back target before newest-created-first ordering.
 * Mobile does not share this exception; do not reuse it as the canonical relationship order.
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

export interface SideChatTreeRow {
  readonly threadId: ThreadId;
  readonly parentId: ThreadId | null;
  readonly depth: number;
  readonly label: string;
  readonly state: "lesson" | "open" | "done";
  readonly noteStatus: "generating" | "ready" | "none" | "failed" | null;
}

type SideChatTreeShell = Pick<EnvironmentThreadShell, "id" | "title" | "createdAt" | "sideChat">;

interface SideChatTreeMember {
  readonly id: ThreadId;
  readonly createdAt: string;
  readonly sideChat: NonNullable<SideChatTreeShell["sideChat"]>;
}

function compareSideChatSiblings(left: SideChatTreeMember, right: SideChatTreeMember): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Side chats live in their lesson's panel, so Lineage shows one only as the current thread. */
export function isLineageThread(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "sideChat">,
  currentThreadId: ThreadId,
): boolean {
  return thread.id === currentThreadId || !isSideChatThread(thread);
}

/**
 * The lesson and its side chats as rows for the map: the lesson first, then
 * depth-first preorder with siblings in creation order. A side chat whose
 * parent is not one of the lesson's side chats hangs under the lesson.
 */
export function deriveSideChatTree(
  shells: ReadonlyArray<SideChatTreeShell>,
  lessonThreadId: ThreadId,
): ReadonlyArray<SideChatTreeRow> {
  // Callers order shells from most to least authoritative, so the first wins.
  const shellsById = new Map<ThreadId, SideChatTreeShell>();
  for (const shell of shells) {
    if (!shellsById.has(shell.id)) shellsById.set(shell.id, shell);
  }

  const members: SideChatTreeMember[] = [];
  for (const { id, createdAt, sideChat } of shellsById.values()) {
    if (id === lessonThreadId || sideChat?.lessonThreadId !== lessonThreadId) continue;
    members.push({ id, createdAt, sideChat });
  }
  members.sort(compareSideChatSiblings);

  const memberIds = new Set(members.map((member) => member.id));
  const childrenByParentId = new Map<ThreadId, SideChatTreeMember[]>();
  for (const member of members) {
    const anchorThreadId = member.sideChat.anchor.threadId;
    const parentId = memberIds.has(anchorThreadId) ? anchorThreadId : lessonThreadId;
    const siblings = childrenByParentId.get(parentId);
    if (siblings === undefined) childrenByParentId.set(parentId, [member]);
    else siblings.push(member);
  }

  const rows: SideChatTreeRow[] = [
    {
      threadId: lessonThreadId,
      parentId: null,
      depth: 0,
      label: shellsById.get(lessonThreadId)?.title ?? "Lesson",
      state: "lesson",
      noteStatus: null,
    },
  ];
  const visited = new Set<ThreadId>();
  const walk = (start: SideChatTreeMember, startParentId: ThreadId, startDepth: number): void => {
    const pending = [{ member: start, parentId: startParentId, depth: startDepth }];
    for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
      const { member, parentId, depth } = entry;
      if (visited.has(member.id)) continue;
      visited.add(member.id);
      rows.push({
        threadId: member.id,
        parentId,
        depth,
        label: member.sideChat.label,
        state: member.sideChat.state,
        noteStatus: member.sideChat.noteStatus,
      });
      const children = childrenByParentId.get(member.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ member: children[index]!, parentId: member.id, depth: depth + 1 });
      }
    }
  };

  for (const child of childrenByParentId.get(lessonThreadId) ?? []) {
    walk(child, lessonThreadId, 1);
  }
  // A member still unvisited sits on a parent cycle, so hang it under the lesson to keep it reachable.
  for (const member of members) {
    if (!visited.has(member.id)) walk(member, lessonThreadId, 1);
  }
  return rows;
}
