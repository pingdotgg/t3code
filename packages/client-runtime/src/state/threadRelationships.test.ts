import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  orderWebThreadLineageRows,
  relatedThreadIds,
  resolveChildAgentDisplayState,
  resolveMergeBackTargetThreadId,
  walkThreadRelationships,
} from "./threadRelationships.ts";

describe("thread relationships", () => {
  it("keeps an older activity run visible over a newer cancelled run", () => {
    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: child,
          title: "Active child",
          activityRunStatus: "running",
          status: "cancelled",
          forkedFrom: { type: "run", threadId: parent, runId: "run-parent" },
          lineage: {
            rootThreadId: parent,
            parentThreadId: parent,
            relationshipToParent: "subagent",
          },
        },
      ] as never,
      projection: null,
    });

    expect(graph.edges).toEqual([
      expect.objectContaining({ targetThreadId: child, status: "running" }),
    ]);
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

  it("shows a reused app-owned child's current run over its completed task record", () => {
    // The parent's record keeps the first delegated task's completion. The
    // child shell reports the follow-up run, which is what Lineage must show.
    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    const childShell = {
      id: child,
      title: "Score findings",
      status: "running",
      activityRunStatus: "running",
      forkedFrom: null,
      lineage: { rootThreadId: parent, parentThreadId: parent, relationshipToParent: "subagent" },
    };
    const projection = {
      thread: { id: parent },
      subagents: [{ childThreadId: child, origin: "app_owned", status: "completed" }],
      contextTransfers: [],
    };

    expect(
      deriveThreadRelationshipGraph({
        threads: [childShell] as never,
        projection: projection as never,
      }).edges,
    ).toEqual([expect.objectContaining({ targetThreadId: child, status: "running" })]);
    // Without a shell the record is all we have.
    expect(
      deriveThreadRelationshipGraph({ threads: [], projection: projection as never }).edges,
    ).toEqual([expect.objectContaining({ targetThreadId: child, status: "completed" })]);
    // Provider-native subagents own their lifecycle; the record stays.
    expect(
      deriveThreadRelationshipGraph({
        threads: [childShell] as never,
        projection: {
          ...projection,
          subagents: [{ childThreadId: child, origin: "provider_native", status: "completed" }],
        } as never,
      }).edges,
    ).toEqual([expect.objectContaining({ targetThreadId: child, status: "completed" })]);
  });

  it("anchors the child agent timer to the child's current run", () => {
    const record = {
      origin: "app_owned" as const,
      status: "completed" as const,
      startedAt: DateTime.makeUnsafe("2026-09-21T23:46:43.632Z"),
      completedAt: DateTime.makeUnsafe("2026-09-21T23:49:12.589Z"),
    };
    const settledShell = {
      status: "completed" as const,
      activityRunStatus: null,
      activityRunStartedAt: null,
      latestRunStartedAt: DateTime.makeUnsafe("2026-09-21T23:46:44.553Z"),
      latestRunCompletedAt: DateTime.makeUnsafe("2026-09-21T23:49:11.458Z"),
    };
    const laterRunStart = DateTime.makeUnsafe("2026-09-22T00:41:25.467Z");
    const laterRunEnd = DateTime.makeUnsafe("2026-09-22T00:52:00.000Z");

    const recordDisplay = {
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    };

    expect(resolveChildAgentDisplayState({ subagent: record, childThread: null })).toEqual(
      recordDisplay,
    );
    expect(resolveChildAgentDisplayState({ subagent: record, childThread: settledShell })).toEqual({
      status: "completed",
      startedAt: settledShell.latestRunStartedAt,
      completedAt: settledShell.latestRunCompletedAt,
    });

    // A later turn starts: running, timed from that run, not the old task.
    const running = {
      status: "running" as const,
      activityRunStatus: "running" as const,
      activityRunStartedAt: laterRunStart,
      latestRunStartedAt: laterRunStart,
      latestRunCompletedAt: null,
    };
    expect(resolveChildAgentDisplayState({ subagent: record, childThread: running })).toEqual({
      status: "running",
      startedAt: laterRunStart,
      completedAt: null,
    });
    for (const activityRunStatus of ["preparing", "starting"] as const) {
      expect(
        resolveChildAgentDisplayState({
          subagent: record,
          childThread: { ...running, status: activityRunStatus, activityRunStatus },
        }).status,
      ).toBe("running");
    }
    expect(
      resolveChildAgentDisplayState({
        subagent: record,
        childThread: { ...running, status: "waiting", activityRunStatus: "waiting" },
      }),
    ).toEqual({ status: "waiting", startedAt: laterRunStart, completedAt: null });

    // Queued follow-up: pending with nothing to time yet.
    expect(
      resolveChildAgentDisplayState({
        subagent: record,
        childThread: { ...settledShell, status: "queued" },
      }),
    ).toEqual({ status: "pending", startedAt: null, completedAt: null });

    // The later turn completes: the timer freezes on that run's span.
    expect(
      resolveChildAgentDisplayState({
        subagent: record,
        childThread: {
          ...settledShell,
          latestRunStartedAt: laterRunStart,
          latestRunCompletedAt: laterRunEnd,
        },
      }),
    ).toEqual({ status: "completed", startedAt: laterRunStart, completedAt: laterRunEnd });
    expect(
      resolveChildAgentDisplayState({
        subagent: record,
        childThread: { ...settledShell, status: "rolled_back" },
      }).status,
    ).toBe("cancelled");

    // A shell with no runs yet says nothing about the task.
    expect(
      resolveChildAgentDisplayState({
        subagent: { ...record, status: "pending", startedAt: null, completedAt: null },
        childThread: {
          status: "idle",
          activityRunStatus: null,
          activityRunStartedAt: null,
          latestRunStartedAt: null,
          latestRunCompletedAt: null,
        },
      }),
    ).toEqual({ status: "pending", startedAt: null, completedAt: null });

    // Provider-native subagents keep the record even with a live shell.
    expect(
      resolveChildAgentDisplayState({
        subagent: { ...record, origin: "provider_native" },
        childThread: running,
      }),
    ).toEqual(recordDisplay);
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
