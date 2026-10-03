import { describe, expect, it } from "vite-plus/test";
import {
  ContextTransferId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  orderWebThreadLineageRows,
  relatedThreadIds,
  resolveMergeBackTargetThreadId,
  pendingMergeBackNotice,
  resolvePendingMergeBack,
  resolvePendingMergeBackTransfer,
  walkThreadRelationships,
  threadRelationshipRowStatus,
} from "./threadRelationships.ts";

describe("thread relationships", () => {
  it.each([
    ["running", "completed"],
    ["completed", "running"],
    ["running", "running"],
    ["completed", "completed"],
    ["waiting", "failed"],
    ["interrupted", "pending"],
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

describe("pending merge-back", () => {
  const target = ThreadId.make("thread-target");
  const fork = ThreadId.make("thread-fork");
  const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
  const thread = {
    id: target,
    projectId: ProjectId.make("project"),
    title: "Source thread",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: target, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2ThreadProjection["thread"];

  function transfer(id: string, overrides: Partial<OrchestrationV2ContextTransfer> = {}) {
    return {
      id: ContextTransferId.make(id),
      type: "merge_back",
      status: "pending",
      sourceThreadId: fork,
      targetThreadId: target,
      sourcePoint: { threadId: fork },
      basePoint: null,
      sourceProviderInstanceId: null,
      targetProviderInstanceId: null,
      targetRunId: null,
      resolution: null,
      createdBy: "user",
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: null,
      ...overrides,
    } satisfies OrchestrationV2ContextTransfer;
  }

  function resolve(contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>) {
    return resolvePendingMergeBackTransfer({ thread, contextTransfers });
  }

  it("returns null for a missing projection or no transfers", () => {
    expect(resolvePendingMergeBackTransfer(null)).toBeNull();
    expect(resolve([])).toBeNull();
  });

  it("selects by updatedAt rather than creation or array order without copying or sorting", () => {
    const newer = Object.freeze(
      transfer("newer", {
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:02:00.000Z"),
      }),
    );
    const older = Object.freeze(
      transfer("older", {
        createdAt: DateTime.makeUnsafe("2026-06-20T00:03:00.000Z"),
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:01:00.000Z"),
      }),
    );
    expect(resolve(Object.freeze([newer, older]))).toBe(newer);
    expect(resolve(Object.freeze([older, newer]))).toBe(newer);
  });

  it("matches the server's last-entry-wins tie-break for equal updatedAt", () => {
    const first = transfer("first");
    const second = transfer("second");
    expect(resolve([first, second])).toBe(second);
    expect(resolve([second, first])).toBe(first);
  });

  it.each(["resolved_native", "resolved_portable", "failed", "consumed", "superseded"] as const)(
    "ignores a newer %s transfer",
    (status) => {
      const pending = transfer("pending");
      const settled = transfer("settled", {
        status,
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:05:00.000Z"),
      });
      expect(resolve([pending, settled])).toBe(pending);
      expect(resolve([settled])).toBeNull();
    },
  );

  it.each(["fork", "provider_handoff", "subagent_spawn", "subagent_result"] as const)(
    "ignores a pending %s transfer",
    (type) => {
      expect(resolve([transfer("other", { type })])).toBeNull();
    },
  );

  it("ignores outgoing transfers and transfers for a different target", () => {
    expect(
      resolve([
        transfer("outgoing", { sourceThreadId: target, targetThreadId: fork }),
        transfer("elsewhere", { targetThreadId: ThreadId.make("elsewhere") }),
      ]),
    ).toBeNull();
  });

  it("replaces a superseded merge-back and clears when the replacement is consumed", () => {
    const first = transfer("first");
    expect(resolve([first])).toBe(first);
    const superseded = { ...first, status: "superseded" as const };
    const replacement = transfer("replacement");
    expect(resolve([superseded, replacement])).toBe(replacement);
    expect(resolve([superseded, { ...replacement, status: "consumed" }])).toBeNull();
  });

  function resolveState(
    contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
    runStatuses: ReadonlyArray<string> = [],
  ) {
    return resolvePendingMergeBack({
      thread,
      contextTransfers,
      runs: runStatuses.map((status) => ({ status })) as never,
    });
  }

  it("expects the next send to carry the transfer on an idle thread", () => {
    const pending = transfer("pending");
    expect(resolveState([pending], ["completed", "interrupted"])).toEqual({
      transfer: pending,
      forkCount: 1,
      waitsForIdle: false,
    });
    expect(resolveState([])).toBeNull();
    expect(resolvePendingMergeBack(null)).toBeNull();
  });

  it.each(["preparing", "starting", "running", "waiting"])(
    "waits for idle while a run is %s, as the server rejects or steers that send",
    (status) => {
      expect(resolveState([transfer("pending")], ["completed", status])?.waitsForIdle).toBe(true);
    },
  );

  it("counts distinct pending forks, which the server rejects together", () => {
    const otherFork = ThreadId.make("thread-other-fork");
    const later = DateTime.makeUnsafe("2026-06-20T00:01:00.000Z");
    const state = resolveState([
      transfer("fork-older", { status: "superseded" }),
      transfer("fork-newer"),
      transfer("other-fork", { sourceThreadId: otherFork, updatedAt: later }),
      transfer("third-fork-done", { sourceThreadId: ThreadId.make("done"), status: "consumed" }),
    ]);
    expect(state?.forkCount).toBe(2);
    expect(state?.transfer.id).toBe("other-fork");
    expect(resolveState([transfer("a"), transfer("b", { updatedAt: later })])?.forkCount).toBe(1);
  });

  it("only marks the notice as blocking when more than one fork is pending", () => {
    const notice = (forkCount: number, waitsForIdle: boolean) =>
      pendingMergeBackNotice({ sourceThreadTitle: "Fork", forkCount, waitsForIdle });
    expect(notice(1, false).blocked).toBe(false);
    expect(notice(1, true).blocked).toBe(false);
    expect(notice(1, true).description).not.toBe(notice(1, false).description);
    expect(notice(2, false).blocked).toBe(true);
    expect(notice(2, true).blocked).toBe(true);
  });
});
