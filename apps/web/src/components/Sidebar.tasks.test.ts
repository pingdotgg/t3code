import { EnvironmentId, ProjectId, ProviderInstanceId, TaskId, ThreadId } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedTaskKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeTaskRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadOrderRow, type TaskGroupingTask } from "@t3tools/client-runtime/state/task-grouping";
import { describe, expect, it } from "vite-plus/test";
import {
  buildTaskSidebarInventory,
  planTaskSidebarReorder,
  resolveTaskSidebarDrop,
  taskSidebarItemId,
  type TaskSidebarDraft,
} from "./Sidebar.tasks";
import { sidebarMarkerId } from "./Sidebar.logic";

const environmentId = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("primary");
const now = "2026-09-13T12:00:00.000Z";
const task = (overrides: Partial<TaskGroupingTask> = {}): TaskGroupingTask => ({
  environmentId,
  id: TaskId.make("task"),
  name: "Release",
  description: null,
  primaryProjectId: projectId,
  createdAt: now,
  updatedAt: now,
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
});
const thread = (
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell => ({
  environmentId,
  id: ThreadId.make(id),
  taskId: task().id,
  projectId,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});
const taskKey = scopedTaskKey(scopeTaskRef(environmentId, task().id));
const key = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
const base = {
  tasks: [task()],
  threads: [thread("one"), thread("two")],
  taskCapableEnvironmentIds: new Set([environmentId]),
  now,
};
const content = (input: Parameters<typeof buildTaskSidebarInventory>[0]) =>
  buildTaskSidebarInventory(input).items.filter((item) => item.kind !== "marker");

describe("task sidebar inventory", () => {
  it("interleaves top-level entities and keeps every structural child in its task block", () => {
    const draft: TaskSidebarDraft = { key: "draft", environmentId, projectId, taskId: task().id };
    const items = content({
      ...base,
      tasks: [task({ activeOrderKey: "a" })],
      threads: [
        thread("one"),
        thread("parked", { settledOverride: "settled" }),
        thread("free", { taskId: null, activeOrderKey: "z" }),
      ],
      drafts: [draft],
    });
    expect(items.map((item) => item.kind)).toEqual([
      "task",
      "thread",
      "draft",
      "task-new-thread",
      "task-settled-header",
      "thread",
    ]);
    expect(items.slice(1, -1).every((item) => "taskKey" in item && item.taskKey === taskKey)).toBe(
      true,
    );
    expect(items.at(-1)).toMatchObject({ kind: "thread", key: key("free") });
  });

  it("shows empty tasks and keeps matching parents without unrelated children", () => {
    expect(content({ ...base, threads: [] }).map((item) => item.kind)).toEqual([
      "task",
      "task-new-thread",
    ]);
    expect(content({ ...base, search: "release" }).map((item) => item.kind)).toEqual(["task"]);
  });

  it("reveals matching member content while retaining full counts and saved collapse preferences", () => {
    const collapsedTaskKeys = new Set([taskKey]);
    const items = content({
      ...base,
      search: "transcript",
      matchingThreadKeys: new Set([key("two")]),
      collapsedTaskKeys,
    });
    expect(items.map((item) => item.kind)).toEqual(["task", "thread", "task-new-thread"]);
    expect(items[0]).toMatchObject({ counts: { live: 2, snoozed: 0, settled: 0 }, expanded: true });
    expect(items[1]).toMatchObject({ key: key("two") });
    expect(collapsedTaskKeys).toEqual(new Set([taskKey]));
    expect(content({ ...base, collapsedTaskKeys }).map((item) => item.kind)).toEqual(["task"]);
  });

  it("retains the selected member through task, settled sub-shelf and global shelf collapse", () => {
    const items = content({
      ...base,
      tasks: [task({ settledOverride: "settled" })],
      threads: [thread("one", { settledOverride: "settled" }), thread("two")],
      selectedThreadKey: key("one"),
    });
    expect(items.map((item) => item.kind)).toEqual(["task", "task-settled-header", "thread"]);
    expect(items[2]).toMatchObject({ key: key("one"), slim: true, section: "settled" });
  });

  it("keeps a selected invested draft visible inside a collapsed task", () => {
    const items = content({
      ...base,
      drafts: [{ key: "draft", environmentId, projectId, taskId: task().id }],
      collapsedTaskKeys: new Set([taskKey]),
      selectedDraftKey: "draft",
    });
    expect(items.map((item) => item.kind)).toEqual(["task", "draft"]);
  });

  it("keeps project scopes and unsupported environments flat, including draft rows", () => {
    const foreign = ProjectId.make("foreign");
    const input = {
      ...base,
      threads: [thread("foreign", { projectId: foreign }), thread("local")],
      drafts: [{ key: "draft", environmentId, projectId: foreign, taskId: task().id }],
      projectScope: new Set([scopedProjectKey(scopeProjectRef(environmentId, foreign))]),
    };
    expect(content(input).map((item) => item.kind)).toEqual(["draft", "thread"]);
    expect(content(input).every((item) => !("taskKey" in item))).toBe(true);
    expect(
      content({ ...base, taskCapableEnvironmentIds: new Set() }).map((item) => item.kind),
    ).toEqual(["thread", "thread"]);
  });

  it("retains selected settled tail rows beyond the visible limit and flattens old-server lifecycle", () => {
    const items = content({
      ...base,
      tasks: [],
      threads: [
        thread("a", { taskId: null, settledOverride: "settled" }),
        thread("z", { taskId: null, settledOverride: "settled" }),
      ],
      settledExpanded: true,
      settledVisibleCount: 1,
      selectedThreadKey: key("z"),
    });
    expect(items.map(taskSidebarItemId)).toEqual([key("a"), key("z")]);
    expect(
      content({
        ...base,
        taskCapableEnvironmentIds: new Set(),
        threadSettlementEnvironmentIds: new Set(),
        threads: [thread("old", { settledOverride: "settled" })],
      })[0],
    ).toMatchObject({ kind: "thread", section: "active" });
  });
});

describe("task drop intent", () => {
  const inventory = () =>
    buildTaskSidebarInventory({
      ...base,
      tasks: [task(), task({ id: TaskId.make("other"), environmentId: remote })],
      threads: [
        ...base.threads,
        thread("free", { taskId: null }),
        thread("foreign", { taskId: TaskId.make("other"), environmentId: remote }),
      ],
      taskCapableEnvironmentIds: new Set([environmentId, remote]),
    });
  it("distinguishes card membership from ordering slots and rejects cross-environment membership and nesting", () => {
    const { items } = inventory();
    expect(resolveTaskSidebarDrop(items, key("free"), `task:${taskKey}`)?.kind).toBe(
      "move-to-task",
    );
    expect(resolveTaskSidebarDrop(items, key("free"), `task:${taskKey}`, "before")?.kind).toBe(
      "reorder",
    );
    const other = `task:${scopedTaskKey(scopeTaskRef(remote, TaskId.make("other")))}`;
    expect(resolveTaskSidebarDrop(items, key("free"), other)).toBeNull();
    expect(resolveTaskSidebarDrop(items, `task:${taskKey}`, other)).toBeNull();
  });

  it("reorders siblings, prevents unrelated member drops and requires removal before pinning", () => {
    const { items } = inventory();
    expect(resolveTaskSidebarDrop(items, key("one"), key("two"))).toMatchObject({
      kind: "reorder",
      taskKey,
      order: [key("two"), key("one")],
    });
    expect(resolveTaskSidebarDrop(items, key("one"), sidebarMarkerId("pinned-header"))).toBeNull();
    expect(
      resolveTaskSidebarDrop(items, key("one"), sidebarMarkerId("pinned-divider")),
    ).toMatchObject({
      kind: "remove-from-task",
      threadRef: scopeThreadRef(environmentId, ThreadId.make("one")),
      section: "active",
    });
    expect(resolveTaskSidebarDrop(items, key("free"), key("one"))).toBeNull();
  });

  it("uses mixed order planning to materialize keyless neighbors without touching member keys", () => {
    const { items, orderRows } = inventory();
    const drop = resolveTaskSidebarDrop(items, key("free"), `task:${taskKey}`, "before");
    expect(drop?.kind).toBe("reorder");
    if (drop?.kind !== "reorder") throw new Error("Missing reorder");
    const assignments = planTaskSidebarReorder(drop, orderRows);
    expect(assignments.length).toBeGreaterThan(1);
    expect(assignments.some((assignment) => assignment.kind === "task")).toBe(true);
    expect(
      assignments
        .filter((assignment) => assignment.kind === "thread")
        .map((assignment) => assignment.ref.threadId),
    ).toEqual([ThreadId.make("free")]);
    const siblingDrop = resolveTaskSidebarDrop(items, key("one"), key("two"));
    if (siblingDrop?.kind !== "reorder") throw new Error("Missing sibling reorder");
    expect(
      planTaskSidebarReorder(siblingDrop, base.threads.map(threadOrderRow)).map(
        (assignment) => assignment.kind,
      ),
    ).toEqual(["thread", "thread"]);
  });
});
