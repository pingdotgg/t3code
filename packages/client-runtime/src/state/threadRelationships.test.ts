import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  threadChildChats,
  threadRelationshipRowStatus,
} from "./threadRelationships.ts";

const relatedThreadIds = (
  graph: Parameters<typeof immediateThreadRelationships>[0],
  threadId: ThreadId,
) => immediateThreadRelationships(graph, threadId).map((row) => row.threadId);

describe("thread relationships", () => {
  describe("children versus subagents", () => {
    const captain = ThreadId.make("captain");
    const doug = ThreadId.make("doug");
    const cody = ThreadId.make("cody");
    const randy = ThreadId.make("randy");
    const helper = ThreadId.make("helper");
    const shell = (
      id: ThreadId,
      fields: {
        parentThreadId?: ThreadId | null;
        parentEnvironmentId?: string;
        parentRelationship?: "child" | "subagent" | null;
        spawnedBy?: ThreadId;
        createdAt?: string;
      } = {},
    ) => ({
      id,
      status: "running",
      createdAt: DateTime.makeUnsafe(fields.createdAt ?? "2026-10-01T00:00:00.000Z"),
      lineage: {
        parentThreadId: fields.spawnedBy ?? null,
        relationshipToParent: fields.spawnedBy ? "subagent" : null,
      },
      forkedFrom: null,
      ...(fields.parentThreadId === undefined ? {} : { parentThreadId: fields.parentThreadId }),
      ...(fields.parentEnvironmentId === undefined
        ? {}
        : { parentEnvironmentId: fields.parentEnvironmentId }),
      ...(fields.parentRelationship === undefined
        ? {}
        : { parentRelationship: fields.parentRelationship }),
    });
    const graphOf = (threads: ReadonlyArray<object>, projection: object | null = null) =>
      deriveThreadRelationshipGraph({ threads: threads as never, projection: projection as never });
    // The Captain screenshot: launched children plus a named-agent delegate and a helper.
    const fleet = [
      shell(captain),
      shell(doug, { parentThreadId: captain, parentRelationship: "child" }),
      shell(cody, { parentThreadId: captain, createdAt: "2026-09-30T00:00:00.000Z" }),
      shell(randy, { parentThreadId: captain, parentRelationship: "child", spawnedBy: captain }),
      shell(helper, {
        parentThreadId: captain,
        parentRelationship: "subagent",
        spawnedBy: captain,
      }),
    ];

    it("puts only a thread's own subagents in its Lineage, never its children", () => {
      const graph = graphOf(fleet, {
        thread: { id: captain },
        subagents: [
          { childThreadId: randy, status: "completed" },
          { childThreadId: helper, status: "completed" },
        ],
        contextTransfers: [
          { sourceThreadId: captain, targetThreadId: randy, type: "subagent_spawn", status: "x" },
          { sourceThreadId: randy, targetThreadId: captain, type: "subagent_result", status: "x" },
        ],
      });
      expect(relatedThreadIds(graph, captain)).toEqual([helper]);
      expect(graph.edges.map((edge) => edge.kind)).toEqual(["subagent"]);
      expect(relatedThreadIds(graph, doug)).toEqual([]);
      expect(relatedThreadIds(graph, randy)).toEqual([]);
    });

    it("lists a parent's children, oldest first, and follows re-parenting", () => {
      const local = "local";
      // Shells as the client holds them: scoped to an environment, ISO dates.
      const scoped = (environmentId: string, thread: ReturnType<typeof shell>) => ({
        ...thread,
        environmentId,
        parentThreadId: thread.parentThreadId ?? null,
        parentEnvironmentId: thread.parentEnvironmentId ?? null,
        createdAt: DateTime.formatIso(thread.createdAt),
      });
      const childIds = (threads: ReadonlyArray<object>, environmentId: string, id: ThreadId) =>
        threadChildChats(threads as never, {
          environmentId: environmentId as never,
          threadId: id,
        }).map((thread) => `${thread.environmentId}:${thread.id}`);
      const localFleet = fleet.map((thread) => scoped(local, thread));
      expect(childIds(localFleet, local, captain)).toEqual([
        "local:cody",
        "local:doug",
        "local:randy",
      ]);
      const moved = [
        ...localFleet.filter((thread) => thread.id !== doug),
        scoped(local, shell(doug, { parentThreadId: cody, parentRelationship: "child" })),
      ];
      expect(childIds(moved, local, cody)).toEqual(["local:doug"]);
      const detached = [
        scoped(local, shell(captain)),
        scoped(local, shell(doug, { parentThreadId: null, parentRelationship: null })),
      ];
      expect(childIds(detached, local, captain)).toEqual([]);
    });

    it("lists a child chat on another environment under its parent, as the board nests it", () => {
      const scoped = (environmentId: string, thread: ReturnType<typeof shell>) => ({
        ...thread,
        environmentId,
        parentThreadId: thread.parentThreadId ?? null,
        parentEnvironmentId: thread.parentEnvironmentId ?? null,
        createdAt: DateTime.formatIso(thread.createdAt),
      });
      const threads = [
        scoped("machine-a", shell(captain)),
        // Doug runs on machine B, parented to Captain on machine A.
        scoped(
          "machine-b",
          shell(doug, {
            parentThreadId: captain,
            parentEnvironmentId: "machine-a",
            parentRelationship: "child",
          }),
        ),
        // Same thread id on machine B without a remote parent is B's own child.
        scoped("machine-b", shell(cody, { parentThreadId: captain, parentRelationship: "child" })),
        // A remote subagent link is never a child chat.
        scoped(
          "machine-b",
          shell(helper, {
            parentThreadId: captain,
            parentEnvironmentId: "machine-a",
            parentRelationship: "subagent",
            spawnedBy: captain,
          }),
        ),
      ];
      const childIds = (environmentId: string) =>
        threadChildChats(threads as never, {
          environmentId: environmentId as never,
          threadId: captain,
        }).map((thread) => `${thread.environmentId}:${thread.id}`);
      expect(childIds("machine-a")).toEqual(["machine-b:doug"]);
      expect(childIds("machine-b")).toEqual(["machine-b:cody"]);
    });
  });

  it.each([
    ["running", "completed"],
    ["completed", "running"],
  ])("keeps parent %s independent of child %s", (parentStatus, childStatus) => {
    const parent = ThreadId.make("parent");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: parent,
          activityRunStatus: parentStatus,
          status: "cancelled",
          lineage: { parentThreadId: null },
        },
        {
          id: child,
          activityRunStatus: childStatus,
          lineage: { parentThreadId: parent, relationshipToParent: "fork" },
        },
      ] as never,
      projection: null,
    });
    expect(threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, child)[0]!)).toBe(
      parentStatus,
    );
    expect(
      threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, parent)[0]!),
    ).toBe(childStatus);
  });

  it("does not label a missing parent with its child's running status", () => {
    const parent = ThreadId.make("missing-parent");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: child,
          status: "running",
          lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
        },
      ] as never,
      projection: null,
    });
    expect(
      threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, child)[0]!),
    ).toBeNull();
  });

  it.each(["fork", "subagent"] as const)(
    "keeps the parent edge of an opened %s omitted from the shell",
    (relationshipToParent) => {
      const parent = ThreadId.make("parent");
      const child = ThreadId.make("omitted-child");
      const projection = {
        thread: {
          id: child,
          forkedFrom:
            relationshipToParent === "fork"
              ? { type: "run", threadId: parent, runId: "source-run" }
              : null,
          lineage: { rootThreadId: parent, parentThreadId: parent, relationshipToParent },
        },
        subagents: [],
        contextTransfers: [],
      } as never;
      const graph = deriveThreadRelationshipGraph({ threads: [], projection });
      expect(immediateThreadRelationships(graph, child)).toEqual([
        expect.objectContaining({
          threadId: parent,
          edge: expect.objectContaining({
            sourceThreadId: parent,
            targetThreadId: child,
            kind: relationshipToParent,
          }),
        }),
      ]);
      expect(resolveMergeBackTargetThreadId(projection)).toBe(
        relationshipToParent === "fork" ? parent : null,
      );
    },
  );

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
});
