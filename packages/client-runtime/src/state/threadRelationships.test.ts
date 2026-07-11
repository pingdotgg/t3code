import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  deriveThreadRelationshipGraph,
  flattenSubagentThreadTree,
  getOwnedSubagentDescendants,
  getOwnedSubagentSubtree,
  getSubagentThreadAncestorKeys,
  getSubagentThreadTreeRoots,
  hasUnavailableSubagentParent,
  immediateThreadRelationships,
  isSubagentThread,
  relatedThreadIds,
  resolveMergeBackTargetThreadId,
  subagentThreadKey,
  threadSubtreeActionCopy,
  type SubagentThreadTreeInput,
  walkThreadRelationships,
} from "./threadRelationships.ts";

const environmentId = EnvironmentId.make("environment-1");

function treeThread(input: {
  readonly id: string;
  readonly parentId?: string | null;
  readonly relationship?: "subagent" | "fork" | null;
  readonly updatedAt?: string;
}): SubagentThreadTreeInput {
  const id = ThreadId.make(input.id);
  const parentThreadId = input.parentId ? ThreadId.make(input.parentId) : null;
  return {
    environmentId,
    id,
    lineage: {
      rootThreadId: parentThreadId ?? id,
      parentThreadId,
      relationshipToParent: input.relationship ?? null,
    },
    createdAt: input.updatedAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-01T00:00:00.000Z",
    latestUserMessageAt: input.updatedAt ?? null,
  };
}

describe("thread relationships", () => {
  it("projects nested subagents while keeping forks as roots", () => {
    const root = treeThread({ id: "root" });
    const olderChild = treeThread({
      id: "child-old",
      parentId: "root",
      relationship: "subagent",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const newerChild = treeThread({
      id: "child-new",
      parentId: "root",
      relationship: "subagent",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const grandchild = treeThread({
      id: "grandchild",
      parentId: "child-new",
      relationship: "subagent",
    });
    const fork = treeThread({ id: "fork", parentId: "root", relationship: "fork" });
    const threads = [root, olderChild, newerChild, grandchild, fork];
    const roots = getSubagentThreadTreeRoots(threads);
    const rows = flattenSubagentThreadTree({
      threads,
      roots,
      expandedThreadKeys: new Set([subagentThreadKey(root), subagentThreadKey(newerChild)]),
      threadSortOrder: "updated_at",
    });

    expect(isSubagentThread(olderChild)).toBe(true);
    expect(roots.map((thread) => thread.id)).toEqual([root.id, fork.id]);
    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      [root.id, 0],
      [newerChild.id, 1],
      [grandchild.id, 2],
      [olderChild.id, 1],
      [fork.id, 0],
    ]);
    expect(getSubagentThreadAncestorKeys(threads, subagentThreadKey(grandchild))).toEqual(
      new Set([subagentThreadKey(newerChild), subagentThreadKey(root)]),
    );
  });

  it("walks only recursively owned subagents and stays scoped to the environment", () => {
    const root = treeThread({ id: "root" });
    const child = treeThread({ id: "child", parentId: "root", relationship: "subagent" });
    const grandchild = treeThread({
      id: "grandchild",
      parentId: "child",
      relationship: "subagent",
    });
    const fork = treeThread({ id: "fork", parentId: "root", relationship: "fork" });
    const otherEnvironmentChild = {
      ...treeThread({ id: "other-child", parentId: "root", relationship: "subagent" }),
      environmentId: EnvironmentId.make("environment-2"),
    };
    const threads = [root, child, grandchild, fork, otherEnvironmentChild];

    expect(getOwnedSubagentDescendants(threads, root).map((thread) => thread.id)).toEqual([
      child.id,
      grandchild.id,
    ]);
    expect(getOwnedSubagentSubtree(threads, root).map((thread) => thread.id)).toEqual([
      root.id,
      child.id,
      grandchild.id,
    ]);
  });

  it("bounds malformed ownership cycles", () => {
    const root = treeThread({ id: "root", parentId: "child", relationship: "subagent" });
    const child = treeThread({ id: "child", parentId: "root", relationship: "subagent" });

    expect(getOwnedSubagentDescendants([root, child], root).map((thread) => thread.id)).toEqual([
      child.id,
    ]);
  });

  it("uses consistent subtree action copy", () => {
    expect(
      threadSubtreeActionCopy({
        action: "delete",
        threadTitle: "Parent",
        descendantCount: 2,
      }),
    ).toEqual({
      title: "Delete thread and 2 subagent threads?",
      message:
        "“Parent” and its 2 subagent threads will be permanently deleted, including their conversation and terminal history.",
      confirmText: "Delete",
    });
    expect(
      threadSubtreeActionCopy({
        action: "unarchive",
        threadTitle: "Parent",
        descendantCount: 1,
      }).message,
    ).toBe("“Parent” and its 1 subagent thread archived with it will be restored.");
    expect(
      threadSubtreeActionCopy({
        action: "archive",
        threadTitle: "Parent",
        descendantCount: 1,
        activeThreadCount: 2,
      }).message,
    ).toBe(
      "“Parent” and its 1 subagent thread will be moved to the archive. Active work in 2 threads will be cancelled.",
    );
  });

  it("keeps orphans and rootless cycles visible exactly once", () => {
    const orphan = treeThread({
      id: "orphan",
      parentId: "missing",
      relationship: "subagent",
    });
    const first = treeThread({ id: "cycle-a", parentId: "cycle-b", relationship: "subagent" });
    const second = treeThread({ id: "cycle-b", parentId: "cycle-a", relationship: "subagent" });
    const threads = [orphan, first, second];
    const roots = getSubagentThreadTreeRoots(threads);
    const rows = flattenSubagentThreadTree({
      threads,
      roots,
      expandedThreadKeys: new Set(threads.map(subagentThreadKey)),
      threadSortOrder: "created_at",
    });

    expect(roots.map((thread) => thread.id)).toEqual([orphan.id, first.id]);
    expect(rows.map((row) => row.thread.id)).toEqual([orphan.id, first.id, second.id]);
    expect(new Set(rows.map((row) => subagentThreadKey(row.thread))).size).toBe(3);
    expect(rows.at(-1)?.hasSubagentChildren).toBe(false);
    expect(hasUnavailableSubagentParent(threads, orphan)).toBe(true);
    expect(hasUnavailableSubagentParent(threads, second)).toBe(false);
  });

  it("only returns ancestors from the projected tree", () => {
    const orphan = treeThread({
      id: "orphan",
      parentId: "missing",
      relationship: "subagent",
    });
    const first = treeThread({
      id: "cycle-a",
      parentId: "cycle-b",
      relationship: "subagent",
    });
    const second = treeThread({
      id: "cycle-b",
      parentId: "cycle-a",
      relationship: "subagent",
    });
    const threads = [orphan, first, second];

    expect(getSubagentThreadAncestorKeys(threads, subagentThreadKey(orphan))).toEqual(new Set());
    expect(getSubagentThreadAncestorKeys(threads, subagentThreadKey(first))).toEqual(new Set());
    expect(getSubagentThreadAncestorKeys(threads, subagentThreadKey(second))).toEqual(
      new Set([subagentThreadKey(first)]),
    );
  });

  it("keeps missing parents and cycles navigable without recursive traversal", () => {
    const root = ThreadId.make("thread-root");
    const child = ThreadId.make("thread-child");
    const missing = ThreadId.make("thread-missing");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: root,
          title: "Root",
          status: "completed",
          forkedFrom: { type: "run", threadId: child, runId: "run-cycle" },
          lineage: { rootThreadId: root, parentThreadId: child, relationshipToParent: "fork" },
        },
        {
          id: child,
          title: "Child",
          status: "completed",
          forkedFrom: { type: "run", threadId: missing, runId: "run-missing" },
          lineage: { rootThreadId: root, parentThreadId: missing, relationshipToParent: "fork" },
        },
      ] as never,
      projection: null,
    });

    expect(graph.nodes.get(missing)?.missing).toBe(true);
    expect(relatedThreadIds(graph, root)).toEqual([child]);
    expect(relatedThreadIds(graph, child)).toEqual([root, missing]);
    expect(
      walkThreadRelationships(graph, root).map(({ threadId, depth }) => [threadId, depth]),
    ).toEqual([
      [child, 1],
      [missing, 2],
    ]);
    expect(immediateThreadRelationships(graph, root).map(({ threadId }) => threadId)).toEqual([
      child,
    ]);
  });

  it("combines subagent and transfer edges with archived shell state", () => {
    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    const transferTarget = ThreadId.make("thread-transfer");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: parent,
          title: "Parent",
          status: "completed",
          archivedAt: null,
          forkedFrom: null,
          lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
        },
        {
          id: child,
          title: "Subagent",
          status: "completed",
          archivedAt: "2026-06-24T00:00:00.000Z",
          forkedFrom: null,
          lineage: {
            rootThreadId: parent,
            parentThreadId: parent,
            relationshipToParent: "subagent",
          },
        },
      ] as never,
      projection: {
        thread: { id: parent },
        subagents: [{ childThreadId: child, status: "completed" }],
        contextTransfers: [
          {
            sourceThreadId: child,
            targetThreadId: transferTarget,
            status: "completed",
          },
        ],
      } as never,
    });

    expect(graph.nodes.get(child)?.thread?.archivedAt).not.toBeNull();
    expect(graph.nodes.get(transferTarget)?.missing).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceThreadId: parent,
          targetThreadId: child,
          kind: "subagent",
        }),
        expect.objectContaining({
          sourceThreadId: child,
          targetThreadId: transferTarget,
          kind: "transfer",
        }),
      ]),
    );
  });

  it("resolves merge-back only for forks and prefers the recorded fork source", () => {
    const source = ThreadId.make("thread-source");
    const fallbackParent = ThreadId.make("thread-parent");
    const fork = ThreadId.make("thread-fork");

    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: { type: "run", threadId: source, runId: "run-source" },
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "fork",
          },
        },
      } as never),
    ).toBe(source);
    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: null,
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "fork",
          },
        },
      } as never),
    ).toBe(fallbackParent);
    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: null,
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "subagent",
          },
        },
      } as never),
    ).toBeNull();
  });
});
