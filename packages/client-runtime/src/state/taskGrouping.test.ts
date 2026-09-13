import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  scopedProjectKey,
  scopedTaskKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeTaskRef,
  scopeThreadRef,
} from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  buildTaskMembershipIndex,
  groupThreadsByTask,
  partitionTaskMembers,
  planTaskRowReorder,
  resolveSettledTaskTimestamp,
  rollupTaskStatus,
  sortTaskRowsByOrderKey,
  taskMemberStatus,
  taskOrderRow,
  taskShelf,
  effectiveTaskShelf,
  taskMatchesSearch,
  taskHasLocalWork,
  resolveTaskPresentation,
  taskChildVisible,
  threadOrderRow,
  type TaskGroupingTask,
  type TaskMemberStatus,
} from "./taskGrouping.ts";

const environmentId = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectA = ProjectId.make("a");
const projectB = ProjectId.make("b");
const now = "2026-09-13T12:00:00.000Z";
const future = "2026-09-14T12:00:00.000Z";
const past = "2026-09-12T12:00:00.000Z";

function task(overrides: Partial<TaskGroupingTask> = {}): TaskGroupingTask {
  return {
    environmentId,
    id: TaskId.make("shared-id"),
    name: "Task",
    description: null,
    primaryProjectId: projectA,
    createdAt: past,
    updatedAt: past,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    ...overrides,
  };
}

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make("shared-id"),
    taskId: null,
    projectId: projectA,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: past,
    updatedAt: past,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function session(status: NonNullable<EnvironmentThreadShell["session"]>["status"]) {
  return {
    threadId: ThreadId.make("shared-id"),
    status,
    providerName: "codex" as const,
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  };
}

const memberKey = (member: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(member.environmentId, member.id));
const taskKey = (value: TaskGroupingTask) =>
  scopedTaskKey(scopeTaskRef(value.environmentId, value.id));

describe("task membership", () => {
  it("indexes equal task and thread IDs separately by environment and preserves member references", () => {
    const localMember = thread({ taskId: task().id });
    const remoteMember = thread({ taskId: task().id, environmentId: remote, projectId: projectB });
    const secondTask = task({ id: TaskId.make("second") });
    const secondMember = thread({ id: ThreadId.make("second-member"), taskId: secondTask.id });
    const index = buildTaskMembershipIndex([localMember, remoteMember, secondMember, thread()]);
    expect(index.size).toBe(3);
    expect(index.get(taskKey(task()))).toEqual([localMember]);
    expect(index.get(taskKey(task({ environmentId: remote })))?.[0]).toBe(remoteMember);
    expect(index.get(taskKey(secondTask))).toEqual([secondMember]);
  });

  it("partitions parked members, excludes archives, and keeps queued settled members live within their environment", () => {
    const live = thread();
    const snoozed = thread({ id: ThreadId.make("snoozed"), snoozedUntil: future });
    const settled = thread({ id: ThreadId.make("settled"), settledOverride: "settled" });
    const queued = thread({ id: ThreadId.make("queued"), settledOverride: "settled" });
    const otherEnvironment = { ...queued, environmentId: remote };
    const archived = thread({ archivedAt: now });
    const parts = partitionTaskMembers(
      [live, snoozed, settled, queued, otherEnvironment, archived],
      {
        now,
        queuedThreadKeys: new Set([memberKey(queued)]),
      },
    );
    expect(parts).toEqual({
      live: [live, queued],
      snoozed: [snoozed],
      settled: [settled, otherEnvironment],
    });
  });

  it("uses thread raised-hand and clock rules for snoozed members", () => {
    const expired = thread({ snoozedUntil: now });
    const malformed = thread({ snoozedUntil: "invalid" });
    const approval = thread({ snoozedUntil: future, hasPendingApprovals: true });
    const oldError = thread({
      snoozedUntil: future,
      snoozedAt: now,
      session: { ...session("error"), updatedAt: past },
    });
    const freshError = thread({ snoozedUntil: future, snoozedAt: past, session: session("error") });
    const completed = thread({
      snoozedUntil: future,
      snoozedAt: past,
      latestTurn: {
        turnId: TurnId.make("turn"),
        state: "completed",
        requestedAt: past,
        startedAt: past,
        completedAt: now,
        assistantMessageId: null,
      },
    });
    expect(
      partitionTaskMembers([expired, malformed, approval, oldError, freshError, completed], {
        now,
      }),
    ).toEqual({
      live: [expired, malformed, approval, freshError, completed],
      snoozed: [oldError],
      settled: [],
    });
  });

  it("retains thread snooze precedence over local queued messages", () => {
    const queued = thread({ snoozedUntil: future, settledOverride: "settled" });
    expect(
      partitionTaskMembers([queued], { now, queuedThreadKeys: new Set([memberKey(queued)]) }),
    ).toEqual({ live: [], snoozed: [queued], settled: [] });
  });
});

describe("task roll-up", () => {
  const statuses: readonly [TaskMemberStatus, EnvironmentThreadShell][] = [
    [
      "approval",
      thread({ hasPendingApprovals: true, hasPendingUserInput: true, session: session("running") }),
    ],
    ["input", thread({ hasPendingUserInput: true, session: session("running") })],
    ["working", thread({ session: session("running") })],
    ["error", thread({ session: session("error"), backgroundLiveness: "working" })],
    ["background", thread({ backgroundLiveness: "working" })],
    ["monitoring", thread({ backgroundLiveness: "monitoring" })],
    ["idle", thread()],
  ];
  it.each(statuses)(
    "classifies %s and gives it precedence over less demanding members",
    (status, member) => {
      const remaining = statuses
        .slice(statuses.findIndex(([candidate]) => candidate === status))
        .map(([, value]) => value);
      expect(taskMemberStatus(member)).toBe(status);
      expect(rollupTaskStatus(remaining)).toBe(status);
      expect(rollupTaskStatus(remaining.toReversed())).toBe(status);
    },
  );
  it("treats starting as working and empty tasks as idle", () => {
    expect(rollupTaskStatus([thread({ session: session("starting") })])).toBe("working");
    expect(rollupTaskStatus([])).toBe("idle");
  });
  it("does not roll up settled, snoozed, or archived members", () => {
    const parts = partitionTaskMembers(
      [
        thread({ hasPendingApprovals: true, settledOverride: "settled" }),
        thread({ session: session("running"), snoozedUntil: future }),
        thread({ hasPendingUserInput: true, archivedAt: now }),
        thread({ backgroundLiveness: "monitoring" }),
      ],
      { now },
    );
    expect(rollupTaskStatus(parts.live)).toBe("monitoring");
  });
});

describe("task shelves", () => {
  it("owns its lifecycle independently of members and honors snooze, settlement, and pin precedence", () => {
    const parked = task({ snoozedUntil: future, settledOverride: "settled", pinnedAt: past });
    expect(taskShelf(parked, now)).toBe("snoozed");
    expect(taskShelf(parked, future)).toBe("settled");
    expect(taskShelf({ ...parked, snoozedUntil: "invalid", settledOverride: null }, now)).toBe(
      "pinned",
    );
    expect(taskShelf(task({ snoozedUntil: now }), now)).toBe("active");
  });
  it("uses only task settlement and metadata timestamps for settled rows", () => {
    expect(resolveSettledTaskTimestamp(task())).toBe(past);
    expect(resolveSettledTaskTimestamp(task({ settledAt: now, updatedAt: future }))).toBe(now);
  });
});

describe("groupThreadsByTask", () => {
  it("groups capable environments, retains empty tasks, and keeps unresolved/unsupported members flat", () => {
    const localTask = task();
    const oldServerTask = task({ environmentId: remote });
    const empty = task({ id: TaskId.make("empty") });
    const archivedTask = task({ id: TaskId.make("archived"), archivedAt: now });
    const localMember = thread({ taskId: localTask.id, projectId: projectB });
    const unsupported = thread({ taskId: oldServerTask.id, environmentId: remote });
    const missing = thread({ id: ThreadId.make("missing"), taskId: TaskId.make("not-loaded") });
    const archivedParent = thread({
      id: ThreadId.make("archived-parent"),
      taskId: archivedTask.id,
    });
    const ungrouped = thread();
    const result = groupThreadsByTask({
      tasks: [localTask, oldServerTask, empty, archivedTask],
      threads: [
        localMember,
        unsupported,
        missing,
        archivedParent,
        ungrouped,
        thread({ archivedAt: now }),
      ],
      taskCapableEnvironmentIds: new Set([environmentId]),
    });
    expect(result.tasks).toEqual([localTask, empty]);
    expect(result.ungrouped).toEqual([unsupported, missing, archivedParent, ungrouped]);
    expect(result.membersByTaskKey.get(taskKey(localTask))).toEqual([localMember]);
    expect(
      groupThreadsByTask({
        tasks: [localTask],
        threads: [localMember],
        taskCapableEnvironmentIds: new Set(),
      }).ungrouped,
    ).toEqual([localMember]);
  });

  it("flattens foreign-project members under a logical project scope across environments", () => {
    const localMember = thread({ taskId: task().id, projectId: projectB });
    const remoteMember = thread({ taskId: task().id, projectId: projectB, environmentId: remote });
    const outside = thread({ taskId: task().id });
    const input = {
      tasks: [task(), task({ environmentId: remote })],
      threads: [localMember, remoteMember, outside],
      taskCapableEnvironmentIds: new Set([environmentId, remote]),
      projectScope: new Set(
        [environmentId, remote].map((id) => scopedProjectKey(scopeProjectRef(id, projectB))),
      ),
    };
    expect(groupThreadsByTask(input).tasks).toEqual([]);
    expect(groupThreadsByTask(input).ungrouped).toEqual([localMember, remoteMember]);
    expect(groupThreadsByTask({ ...input, projectScope: new Set() }).ungrouped).toEqual([]);
  });
});

describe("mixed task/thread ordering", () => {
  it("namespaces equal IDs by entity and environment and sorts deterministically", () => {
    const rows = [
      taskOrderRow(task()),
      threadOrderRow(thread()),
      taskOrderRow(task({ environmentId: remote })),
      threadOrderRow(thread({ environmentId: remote })),
    ];
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    for (const shelf of ["active", "pinned"] as const) {
      expect(sortTaskRowsByOrderKey(rows, shelf)).toEqual(
        sortTaskRowsByOrderKey(rows.toReversed(), shelf),
      );
    }
  });

  it("retains active order on ordinary metadata/member activity and reanchors only on reentry", () => {
    const first = taskOrderRow(task({ activeOrderKey: "b" }));
    const second = threadOrderRow(thread({ activeOrderKey: "z" }));
    const fresh = taskOrderRow(task({ id: TaskId.make("fresh"), createdAt: now }));
    expect(sortTaskRowsByOrderKey([second, first, fresh], "active")).toEqual([
      fresh,
      first,
      second,
    ]);
    const changed = taskOrderRow(task({ activeOrderKey: "b", updatedAt: future }));
    expect(sortTaskRowsByOrderKey([second, changed, fresh], "active").map((row) => row.id)).toEqual(
      [fresh.id, first.id, second.id],
    );
    const reopened = taskOrderRow(task({ unsettledAt: future }));
    expect(sortTaskRowsByOrderKey([fresh, reopened, second], "active")).toEqual([
      reopened,
      fresh,
      second,
    ]);
  });

  it.each(["active", "pinned"] as const)(
    "materializes keyless mixed %s rows into dispatchable entity refs",
    (shelf) => {
      const rows = [
        threadOrderRow(thread({ environmentId: remote })),
        taskOrderRow(task()),
        threadOrderRow(thread()),
      ];
      const assignments = planTaskRowReorder({
        rows,
        orderedIds: rows.map((row) => row.id),
        movedId: rows[1]!.id,
        shelf,
      });
      expect(assignments.map(({ kind, ref }) => ({ kind, ref }))).toEqual(
        rows.map(({ kind, ref }) => ({ kind, ref })),
      );
      expect(assignments).toHaveLength(3);
      const keys = assignments.map(({ orderKey }) => orderKey);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(keys).size).toBe(3);
    },
  );

  it.each(["active", "pinned"] as const)(
    "reserves hidden %s keys without writing hidden rows",
    (shelf) => {
      const field = shelf === "active" ? "activeOrderKey" : "pinOrderKey";
      const before = taskOrderRow(task({ [field]: "b" }));
      const moved = threadOrderRow(thread({ [field]: "x" }));
      const after = taskOrderRow(task({ id: TaskId.make("after"), [field]: "z" }));
      const hidden = threadOrderRow(thread({ environmentId: remote, [field]: "n" }));
      const assignments = planTaskRowReorder({
        rows: [before, moved, after, hidden],
        orderedIds: [before.id, moved.id, after.id],
        movedId: moved.id,
        shelf,
      });
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({ kind: "thread", ref: moved.ref });
      const key = assignments[0]!.orderKey;
      expect(key > "b" && key < "z" && key !== "n").toBe(true);
    },
  );

  it("rejects stale or duplicate visible identities before producing assignments", () => {
    const row = taskOrderRow(task());
    expect(
      planTaskRowReorder({
        rows: [row],
        orderedIds: ["missing", row.id],
        movedId: row.id,
        shelf: "active",
      }),
    ).toEqual([]);
    expect(
      planTaskRowReorder({
        rows: [row],
        orderedIds: [row.id, row.id],
        movedId: row.id,
        shelf: "active",
      }),
    ).toEqual([]);
  });
});

describe("task presentation", () => {
  it("matches descriptions without treating the container match as a child match", () => {
    expect(taskMatchesSearch(task({ description: "Release checklist" }), " CHECKLIST ")).toBe(true);
    expect(taskMatchesSearch(task(), "missing")).toBe(false);
    expect(
      resolveTaskPresentation({
        task: task(),
        now,
        hasLocalWork: false,
        collapsed: false,
        searching: true,
        hasMatchingChildren: false,
      }),
    ).toEqual({ shelf: "active", expanded: false });
  });
  it("promotes pending work without changing lifecycle or expansion", () => {
    const parked = task({ settledOverride: "settled", snoozedUntil: future });
    const member = thread({ latestUserMessageAt: now });
    expect(taskHasLocalWork({ members: [], pendingCount: 0, now })).toBe(false);
    expect(taskHasLocalWork({ members: [], pendingCount: 1, now })).toBe(true);
    expect(taskHasLocalWork({ members: [member], pendingCount: 0, now })).toBe(true);
    expect(taskHasLocalWork({ members: [member], pendingCount: 0, now: future })).toBe(false);
    expect(
      resolveTaskPresentation({
        task: parked,
        now,
        hasLocalWork: true,
        collapsed: true,
        searching: false,
        hasMatchingChildren: false,
      }),
    ).toEqual({ shelf: "active", expanded: false });
    expect(taskShelf(parked, now)).toBe("snoozed");
    for (const selected of [false, true])
      for (const pending of [false, true]) {
        expect(taskChildVisible({ expanded: false, matches: true, selected, pending })).toBe(
          selected || pending,
        );
      }
  });
});

describe("effective task shelf", () => {
  it("promotes pending work without losing pinning or changing saved expansion", () => {
    for (const pinnedAt of [null, now])
      for (const settledOverride of [null, "settled"] as const)
        for (const snoozedUntil of [null, future])
          for (const hasLocalWork of [false, true]) {
            const candidate = task({ pinnedAt, settledOverride, snoozedUntil });
            const shelf = effectiveTaskShelf({ task: candidate, now, hasLocalWork });
            expect(shelf).toBe(
              hasLocalWork ? (pinnedAt ? "pinned" : "active") : taskShelf(candidate, now),
            );
            expect(
              resolveTaskPresentation({
                task: candidate,
                now,
                hasLocalWork,
                collapsed: true,
                searching: false,
                hasMatchingChildren: true,
              }),
            ).toEqual({ shelf, expanded: false });
          }
  });
});
