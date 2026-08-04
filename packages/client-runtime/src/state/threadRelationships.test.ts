import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  orderWebThreadLineageRows,
  relatedThreadIds,
  resolveMergeBackTargetThreadId,
  walkThreadRelationships,
} from "./threadRelationships.ts";

describe("thread relationships", () => {
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

  it("keeps the live shell when an archived snapshot contains the same thread id", () => {
    const parent = ThreadId.make("thread-parent");
    const staleParent = ThreadId.make("thread-stale-parent");
    const child = ThreadId.make("thread-child");
    const liveChild = {
      id: child,
      title: "Live child",
      status: "running",
      archivedAt: null,
      forkedFrom: { type: "run", threadId: parent, runId: "run-live" },
      lineage: {
        rootThreadId: parent,
        parentThreadId: parent,
        relationshipToParent: "fork",
      },
    } as const;
    const staleArchivedChild = {
      ...liveChild,
      title: "Stale archived child",
      status: "completed",
      archivedAt: "2026-06-24T00:00:00.000Z",
      forkedFrom: { type: "run", threadId: staleParent, runId: "run-stale" },
      lineage: {
        rootThreadId: staleParent,
        parentThreadId: staleParent,
        relationshipToParent: "fork",
      },
    } as const;

    const graph = deriveThreadRelationshipGraph({
      threads: [liveChild, staleArchivedChild] as never,
      projection: null,
    });

    expect(graph.nodes.get(child)?.thread).toMatchObject({
      title: "Live child",
      status: "running",
      archivedAt: null,
    });
    expect(graph.edges).toEqual([
      expect.objectContaining({
        sourceThreadId: parent,
        targetThreadId: child,
      }),
    ]);
    expect(graph.nodes.has(staleParent)).toBe(false);
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

const current = ThreadId.make("thread-current");

function forkShell(input: {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly status?: string;
}) {
  return {
    id: input.id,
    title: input.id,
    status: input.status ?? "completed",
    archivedAt: null,
    forkedFrom:
      input.parentThreadId === null
        ? null
        : { type: "run", threadId: input.parentThreadId, runId: `run-${input.id}` },
    lineage: {
      rootThreadId: input.parentThreadId ?? input.id,
      parentThreadId: input.parentThreadId,
      relationshipToParent: input.parentThreadId === null ? null : "fork",
    },
    createdAt: input.createdAt === undefined ? undefined : DateTime.makeUnsafe(input.createdAt),
    updatedAt: DateTime.makeUnsafe(input.updatedAt ?? "2026-06-20T00:00:00.000Z"),
  };
}

function orderedLineageIds(input: {
  readonly threads: ReadonlyArray<unknown>;
  readonly mergeTargetThreadId?: ThreadId | null;
  readonly projection?: unknown;
}): ReadonlyArray<ThreadId> {
  const graph = deriveThreadRelationshipGraph({
    threads: input.threads as never,
    projection: (input.projection ?? null) as never,
  });
  return orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, current),
    currentThreadId: current,
    mergeTargetThreadId: input.mergeTargetThreadId ?? null,
  }).map(({ threadId }) => threadId);
}

describe("web thread lineage ordering", () => {
  it("orders sibling forks newest created first", () => {
    const oldest = ThreadId.make("thread-fork-oldest");
    const middle = ThreadId.make("thread-fork-middle");
    const newest = ThreadId.make("thread-fork-newest");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({
            id: oldest,
            parentThreadId: current,
            createdAt: "2026-06-02T00:00:00.000Z",
          }),
          forkShell({
            id: middle,
            parentThreadId: current,
            createdAt: "2026-06-03T00:00:00.000Z",
          }),
          forkShell({
            id: newest,
            parentThreadId: current,
            createdAt: "2026-06-04T00:00:00.000Z",
          }),
        ],
      }),
    ).toEqual([newest, middle, oldest]);
  });

  it("does not reorder when related-thread activity arrives", () => {
    const first = ThreadId.make("thread-fork-a");
    const second = ThreadId.make("thread-fork-b");
    const third = ThreadId.make("thread-fork-c");
    const before = orderedLineageIds({
      threads: [
        forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
        forkShell({ id: first, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
        forkShell({ id: second, parentThreadId: current, createdAt: "2026-06-03T00:00:00.000Z" }),
        forkShell({ id: third, parentThreadId: current, createdAt: "2026-06-04T00:00:00.000Z" }),
      ],
    });

    // The shell snapshot arrives ordered by `updated_at`, and a client-side
    // `thread.updated` re-appends the shell it replaces, so both the input
    // order and the mutable timestamps move under us while the panel is open.
    const after = orderedLineageIds({
      threads: [
        forkShell({
          id: second,
          parentThreadId: current,
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
          status: "running",
        }),
        forkShell({ id: third, parentThreadId: current, createdAt: "2026-06-04T00:00:00.000Z" }),
        forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
        forkShell({
          id: first,
          parentThreadId: current,
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
          status: "failed",
        }),
      ],
    });

    expect(before).toEqual([third, second, first]);
    expect(after).toEqual(before);
  });

  it("pins the parent first and a distinct merge-back target second", () => {
    // The panel keeps its two action rows in place regardless of creation time:
    // parent first, then a merge-back target that is not the parent. The two
    // diverge while a shell update and its projection disagree about the fork
    // source, which is exactly when a moving row would misfire a merge.
    const parent = ThreadId.make("thread-parent");
    const mergeTarget = ThreadId.make("thread-merge-target");
    const newestFork = ThreadId.make("thread-newest-fork");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: parent, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({
            id: current,
            parentThreadId: parent,
            createdAt: "2026-06-02T00:00:00.000Z",
          }),
          forkShell({
            id: mergeTarget,
            parentThreadId: current,
            createdAt: "2026-06-03T00:00:00.000Z",
          }),
          forkShell({
            id: newestFork,
            parentThreadId: current,
            createdAt: "2026-06-09T00:00:00.000Z",
          }),
        ],
        mergeTargetThreadId: mergeTarget,
      }),
    ).toEqual([parent, mergeTarget, newestFork]);
  });

  it("sinks missing nodes and shells without a decoded createdAt", () => {
    const missingTransfer = ThreadId.make("thread-missing-transfer");
    const undated = ThreadId.make("thread-undated-fork");
    const dated = ThreadId.make("thread-dated-fork");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({ id: undated, parentThreadId: current }),
          forkShell({ id: dated, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
        ],
        projection: {
          thread: { id: current },
          subagents: [],
          contextTransfers: [
            { sourceThreadId: current, targetThreadId: missingTransfer, status: "completed" },
          ],
        },
      }),
    ).toEqual([dated, missingTransfer, undated]);
  });

  it("breaks equal creation times by thread id", () => {
    const first = ThreadId.make("thread-fork-a");
    const second = ThreadId.make("thread-fork-b");
    const third = ThreadId.make("thread-fork-c");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({ id: third, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
          forkShell({ id: first, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
          forkShell({ id: second, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
        ],
      }),
    ).toEqual([first, second, third]);
  });
});
