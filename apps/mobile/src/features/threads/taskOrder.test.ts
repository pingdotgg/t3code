import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { EnvironmentId, ThreadId, TaskId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  taskOrderRow,
  threadOrderRow,
  planTaskRowReorder,
} from "@t3tools/client-runtime/state/task-grouping";
import { describe, expect, it } from "vite-plus/test";
import {
  createMobileTaskMovePlanner,
  planMobileTaskMove,
  shouldUseMixedTaskArrangement,
  nextMobileTaskSnoozeExpiry,
  type MobileTaskMoveSnapshot,
} from "./taskOrder";
import { threadOrderAfterMove } from "./threadOrder";
import {
  taskArrangementBlock,
  taskArrangementDestination,
  taskArrangementInsertionOffset,
  type TaskArrangementRow,
} from "./taskArrangement";
import { mobileTaskItemsAreEqual } from "./taskListEquality";
import type { MobileTaskListItem } from "./taskList";
const environmentId = EnvironmentId.make("env");
const NOW = "2026-06-02T00:00:00.000Z";
function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

function makeContainer(overrides: Partial<EnvironmentTask> = {}): EnvironmentTask {
  return {
    environmentId,
    id: TaskId.make("task-1"),
    name: "Task One",
    description: null,
    primaryProjectId: ProjectId.make("project-1"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fixture(overrides: Partial<MobileTaskMoveSnapshot> = {}): MobileTaskMoveSnapshot {
  return {
    tasks: [makeContainer({ activeOrderKey: "a1" })],
    threads: [makeThread({ id: ThreadId.make("loose"), title: "Loose", activeOrderKey: "a0" })],
    capableIds: new Set([environmentId]),
    writableTaskIds: new Set([environmentId]),
    writableThreadIds: new Set([environmentId]),
    now: NOW,
    queued: new Set(),
    ...overrides,
  };
}

describe("prepared mobile task move planner", () => {
  it("agrees with shared command assignments on mixed shelves and reserves parked keys", () => {
    const base = fixture();
    const snapshot = fixture({
      tasks: [
        ...base.tasks,
        makeContainer({
          id: TaskId.make("parked"),
          activeOrderKey: "a2",
          settledOverride: "settled",
        }),
      ],
    });
    const planner = createMobileTaskMovePlanner(snapshot);
    for (const shelf of ["active", "pinned"] as const) {
      for (const row of planner.shelves[shelf]) {
        for (const direction of ["up", "down"] as const) {
          const ids = threadOrderAfterMove(
            planner.shelves[shelf].map((item) => item.id),
            row.id,
            direction,
          );
          const expected =
            ids === null
              ? null
              : planTaskRowReorder({
                  rows: [
                    ...snapshot.tasks.map(taskOrderRow),
                    ...snapshot.threads.map(threadOrderRow),
                  ],
                  orderedIds: ids,
                  movedId: row.id,
                  shelf,
                });
          expect(planner.plan(row, direction)?.assignments ?? null).toEqual(expected);
          expect(planner.canMove(row, direction)).toBe(expected !== null);
          expect(planner.canMove(row, direction)).toBe(expected !== null);
        }
      }
    }
    expect(planner.canMove(taskOrderRow(snapshot.tasks[1]!), "up")).toBe(false);
  });
  it("separates duplicate task/thread IDs across environments", () => {
    const other = EnvironmentId.make("other");
    const a = makeThread({
      id: ThreadId.make("member"),
      title: "A",
      taskId: TaskId.make("task-1"),
      activeOrderKey: "a0",
    });
    const b = { ...a, id: ThreadId.make("second"), activeOrderKey: "a1" };
    const foreign = { ...a, environmentId: other };
    const planner = createMobileTaskMovePlanner(
      fixture({
        tasks: [makeContainer(), makeContainer({ environmentId: other })],
        threads: [a, b, foreign],
        capableIds: new Set([environmentId, other]),
        writableThreadIds: new Set([environmentId, other]),
      }),
    );
    expect(planner.canMove(threadOrderRow(b), "up")).toBe(true);
    expect(
      planner.plan(threadOrderRow(b), {
        targetId: threadOrderRow(foreign).id,
        placement: "before",
      }),
    ).toBeNull();
    expect(planner.canMove(threadOrderRow(foreign), "down")).toBe(false);
  });
  it("blocks unwritable moved rows and peers needing key assignments", () => {
    const other = EnvironmentId.make("old");
    const snapshot = fixture({
      threads: [
        makeThread({
          id: ThreadId.make("old"),
          title: "Old",
          environmentId: other,
          activeOrderKey: null,
        }),
      ],
      tasks: [makeContainer({ activeOrderKey: null })],
    });
    const planner = createMobileTaskMovePlanner(snapshot);
    expect(planner.canMove(threadOrderRow(snapshot.threads[0]!), "up")).toBe(false);
    expect(planner.canMove(taskOrderRow(snapshot.tasks[0]!), "down")).toBe(false);
  });
  it("uses separate pin and active capabilities", () => {
    const base = fixture();
    const snapshot = fixture({
      tasks: base.tasks.map((task) => ({ ...task, pinnedAt: NOW, pinOrderKey: "ac" })),
      threads: base.threads.map((thread) => ({ ...thread, pinnedAt: NOW, pinOrderKey: "ab" })),
      writablePinnedThreadIds: new Set(),
    });
    const planner = createMobileTaskMovePlanner(snapshot);
    expect(planner.canMove(threadOrderRow(snapshot.threads[0]!), "down")).toBe(false);
    expect(planner.canMove(taskOrderRow(snapshot.tasks[0]!), "up")).toBe(true);
  });
  it("promotes queued threads and recomputes task/member snooze expiry", () => {
    const taskWake = "2026-06-02T00:02:00.000Z";
    const memberWake = "2026-06-02T00:01:00.000Z";
    const member = makeThread({
      id: ThreadId.make("member"),
      title: "Member",
      taskId: TaskId.make("task-1"),
      snoozedUntil: memberWake,
    });
    const queued = makeThread({
      id: ThreadId.make("queued"),
      title: "Queued",
      settledOverride: "settled",
    });
    const snapshot = fixture({
      tasks: [makeContainer({ snoozedUntil: taskWake })],
      threads: [member, queued],
      queued: new Set([`${environmentId}:queued`]),
    });
    expect(createMobileTaskMovePlanner(snapshot).shelves.active.map((row) => row.id)).toEqual([
      threadOrderRow(queued).id,
    ]);
    expect(nextMobileTaskSnoozeExpiry(snapshot.tasks, snapshot.threads, NOW)).toBe(
      Date.parse(memberWake),
    );
    expect(nextMobileTaskSnoozeExpiry(snapshot.tasks, snapshot.threads, memberWake)).toBe(
      Date.parse(taskWake),
    );
    const awake = createMobileTaskMovePlanner({ ...snapshot, now: taskWake });
    expect(awake.shelves.snoozed).toEqual([]);
    expect(nextMobileTaskSnoozeExpiry(snapshot.tasks, snapshot.threads, taskWake)).toBeNull();
  });
  it("revalidates stale row identity against the execution snapshot", () => {
    const snapshot = fixture();
    const moved = taskOrderRow(snapshot.tasks[0]!);
    expect(createMobileTaskMovePlanner(snapshot).canMove(moved, "up")).toBe(true);
    for (const tasks of [
      [],
      snapshot.tasks.map((task) => ({ ...task, archivedAt: NOW })),
      snapshot.tasks.map((task) => ({ ...task, settledOverride: "settled" as const })),
    ]) {
      expect(planMobileTaskMove({ ...snapshot, tasks, moved, destination: "up" })).toBeNull();
    }
    expect(
      planMobileTaskMove({ ...snapshot, writableTaskIds: new Set(), moved, destination: "up" }),
    ).toBeNull();
  });
  it("keeps legacy mode selected when v2 is disabled, even with supported tasks", () => {
    const snapshot = fixture();
    expect(shouldUseMixedTaskArrangement(false, snapshot.tasks, snapshot.capableIds)).toBe(false);
    expect(shouldUseMixedTaskArrangement(true, snapshot.tasks, snapshot.capableIds)).toBe(true);
    expect(shouldUseMixedTaskArrangement(true, snapshot.tasks, new Set())).toBe(false);
    expect(
      shouldUseMixedTaskArrangement(
        true,
        snapshot.tasks.map((task) => ({ ...task, archivedAt: NOW })),
        snapshot.capableIds,
      ),
    ).toBe(false);
  });
});

function dragFixture() {
  const task = makeContainer({ activeOrderKey: "a0" });
  const first = makeThread({
    id: ThreadId.make("first"),
    title: "First",
    taskId: task.id,
    activeOrderKey: "a0",
  });
  const second = { ...first, id: ThreadId.make("second"), activeOrderKey: "a1" };
  const foreignTask = makeContainer({ id: TaskId.make("foreign"), activeOrderKey: "a2" });
  const foreign = { ...first, id: ThreadId.make("foreign-member"), taskId: foreignTask.id };
  const loose = makeThread({ id: ThreadId.make("loose"), title: "Loose", activeOrderKey: "a1" });
  const snapshot = fixture({
    tasks: [task, foreignTask],
    threads: [first, second, foreign, loose],
  });
  const planner = createMobileTaskMovePlanner(snapshot);
  const entries = [
    taskOrderRow(task),
    threadOrderRow(first),
    threadOrderRow(second),
    threadOrderRow(loose),
    taskOrderRow(foreignTask),
    threadOrderRow(foreign),
  ];
  const rows: TaskArrangementRow[] = entries.map((row, index) => ({
    key: row.id,
    label: row.id,
    row,
    section: "active",
    offset: index * 56,
    height: 56,
    ...(row.kind === "thread" && row.entity.taskId != null ? { member: true } : {}),
  }));
  const destination = (sourceId: string, contentY: number, cancelled = false) =>
    taskArrangementDestination({
      rows,
      planner,
      sourceId,
      contentY,
      cancelled,
      canChangeSection: () => true,
    });
  return { rows, planner, snapshot, entries, destination };
}

describe("mixed arrangement gesture destinations", () => {
  it("moves a task with its visible children past a standalone row", () => {
    const { rows, entries, destination } = dragFixture();
    expect(taskArrangementBlock(rows, entries[0]!.id)?.height).toBe(168);
    const drop = destination(entries[0]!.id, 220)!;
    expect(drop).toEqual({ section: "active", targetId: entries[3]!.id, placement: "after" });
    expect(taskArrangementInsertionOffset(rows, drop)).toBe(224);
  });
  it("places a standalone thread after the whole target task block", () => {
    const { rows, entries, destination } = dragFixture();
    const drop = destination(entries[3]!.id, 320)!;
    expect(drop.targetId).toBe(entries[4]!.id);
    expect(taskArrangementInsertionOffset(rows, drop)).toBe(336);
  });
  it("allows sibling reorder, rejects cross-task membership drops and cancels", () => {
    const { entries, destination } = dragFixture();
    expect(destination(entries[2]!.id, 60)?.targetId).toBe(entries[1]!.id);
    expect(destination(entries[2]!.id, 285)).toBeNull();
    expect(destination(entries[2]!.id, 60, true)).toBeNull();
  });
  it("cancels a removed source and refuses member lifecycle drops", () => {
    const { rows, entries, snapshot } = dragFixture();
    const removed = createMobileTaskMovePlanner({ ...snapshot, tasks: snapshot.tasks.slice(1) });
    expect(
      taskArrangementDestination({
        rows,
        planner: removed,
        sourceId: entries[0]!.id,
        contentY: 220,
        canChangeSection: () => true,
      }),
    ).toBeNull();
    const parked: TaskArrangementRow = {
      key: "settled",
      label: "Settled",
      section: "settled",
      offset: 336,
      height: 48,
    };
    const planner = createMobileTaskMovePlanner(snapshot);
    expect(
      taskArrangementDestination({
        rows: [...rows, parked],
        planner,
        sourceId: entries[1]!.id,
        contentY: 350,
        canChangeSection: () => true,
      }),
    ).toBeNull();
    expect(
      taskArrangementDestination({
        rows: [...rows, parked],
        planner,
        sourceId: entries[3]!.id,
        contentY: 350,
        canChangeSection: () => true,
      }),
    ).toEqual({ section: "settled", targetId: null, placement: "before" });
  });
});

describe("mobile task item equality", () => {
  const task = makeContainer();
  const member = makeThread({ id: ThreadId.make("member"), title: "Member" });
  const item: Extract<MobileTaskListItem, { type: "task-card" | "task-slim" }> = {
    type: "task-card",
    key: "task:env:task-1",
    task,
    expanded: true,
    count: 1,
    selected: false,
    snoozed: false,
    status: "idle",
    members: [member],
    primaryProject: null,
    snoozeWakeLabelText: undefined,
  };
  it("ignores new arrays containing identical members", () => {
    expect(mobileTaskItemsAreEqual(item, { ...item, members: [...item.members] })).toBe(true);
  });
  it.each([
    { type: "task-slim" },
    { key: "different" },
    { task: { ...task, name: "Changed" } },
    { expanded: false },
    { count: 2 },
    { selected: true },
    { retainedShelfVisibleCount: 0 },
    { retainedShelfVisibleCount: 25 },
    { snoozed: true },
    { status: "running" },
    { snoozeWakeLabelText: "Tomorrow" },
    { members: [{ ...member, hasPendingApprovals: true }] },
    { members: [] },
    { primaryProject: { id: ProjectId.make("project"), title: "Project" } },
  ])("updates for observable field change %j", (patch) => {
    expect(mobileTaskItemsAreEqual(item, { ...item, ...patch } as MobileTaskListItem)).toBe(false);
  });
  it("compares member order, subshelf count/expansion and preview controls", () => {
    const another = { ...member, id: ThreadId.make("another") };
    expect(
      mobileTaskItemsAreEqual(
        { ...item, members: [member, another] },
        { ...item, members: [another, member] },
      ),
    ).toBe(false);
    const shelf: MobileTaskListItem = {
      type: "task-subshelf-header",
      key: "shelf",
      task,
      count: 1,
      expanded: true,
    };
    expect(mobileTaskItemsAreEqual(shelf, { ...shelf, count: 2 })).toBe(false);
    expect(mobileTaskItemsAreEqual(shelf, { ...shelf, expanded: false })).toBe(false);
    const create: MobileTaskListItem = {
      type: "task-thread-limit",
      key: "limit",
      task,
      count: 10,
      expanded: false,
    };
    expect(mobileTaskItemsAreEqual(create, { ...create, count: 11 })).toBe(false);
    expect(mobileTaskItemsAreEqual(create, { ...create, expanded: true })).toBe(false);
    expect(mobileTaskItemsAreEqual(create, { ...create })).toBe(true);
    expect(mobileTaskItemsAreEqual(create, { ...create, task: { ...task, archivedAt: NOW } })).toBe(
      false,
    );
  });
});
