import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, TaskId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const calls = vi.hoisted(() => ({ render: vi.fn(), setExpanded: vi.fn() }));
vi.mock("../../hooks/useTaskActions", () => ({
  useTaskActions: () => {
    calls.render();
    return {};
  },
}));
vi.mock("../../hooks/useTaskActionMenu", () => ({
  useTaskActionMenu: () => ({ openMenu: () => undefined }),
}));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (selector: (state: { setTaskExpanded: typeof calls.setExpanded }) => unknown) =>
    selector({ setTaskExpanded: calls.setExpanded }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../../state/shell", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentShell: {
      statusAtom: Atom.family((_id: EnvironmentId) => Atom.make("live")),
    },
  };
});

import { environmentShell } from "../../state/shell";
import { TaskSidebarRow } from "./TaskSidebarRow";
import { buildTaskSidebarInventory } from "../Sidebar.tasks";

const task: EnvironmentTask = {
  environmentId: EnvironmentId.make("local"),
  id: TaskId.make("task"),
  primaryProjectId: ProjectId.make("project"),
  name: "Release",
  description: null,
  createdAt: "2026-09-13T10:00:00.000Z",
  updatedAt: "2026-09-13T10:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
};
const project: EnvironmentProject = {
  environmentId: task.environmentId,
  id: task.primaryProjectId,
  title: "Project",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
};
const initial: ComponentProps<typeof TaskSidebarRow> = {
  task,
  project,
  section: "active",
  expanded: true,
  retainedShelfVisibleCount: undefined,
  revealShelf: () => undefined,
  liveCount: 2,
  snoozedCount: 0,
  settledCount: 1,
  status: "idle",
  settleBlocked: false,
  timeLabel: "2h ago",
  selected: false,
};
let renderer: ReactTestRenderer;
let registry: AtomRegistry.AtomRegistry;
let props: typeof initial;
async function render(change: Partial<typeof initial> = {}) {
  props = { ...props, ...change };
  await act(() => {
    const tree = (
      <RegistryContext.Provider value={registry}>
        <TaskSidebarRow {...props} />
      </RegistryContext.Provider>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.render.mockClear();
  calls.setExpanded.mockReset();
  props = initial;
  registry = AtomRegistry.make();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined!;
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("task content render boundary", () => {
  it("skips unrelated inventory renders and updates each visible primitive", async () => {
    await render();
    expect(calls.render).toHaveBeenCalledTimes(1);
    // An outer inventory/drag render allocates new props but retains the entities and scalars.
    await render();
    await render();
    expect(calls.render).toHaveBeenCalledTimes(1);
    const changes: Partial<typeof initial>[] = [
      { liveCount: 3 },
      { snoozedCount: 1 },
      { settledCount: 2 },
      { status: "working" },
      { timeLabel: "3h ago" },
      { selected: true },
      { settleBlocked: true },
      { expanded: false },
      { retainedShelfVisibleCount: 25 },
      { task: { ...task, name: "Renamed" } },
      { project: { ...project, title: "Renamed project" } },
      { section: "snoozed" },
    ];
    for (const [index, change] of changes.entries()) {
      await render(change);
      expect(calls.render).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("reveals a retained empty task's shelf and page before its normal collapse action", async () => {
    const selected = {
      ...task,
      settledOverride: "settled" as const,
      settledAt: "2026-01-01T00:00:00.000Z",
    };
    const tasks = [
      selected,
      ...["middle", "newest"].map((id, index) => ({
        ...selected,
        id: TaskId.make(id),
        settledAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      })),
    ];
    const taskKey = `${task.environmentId}:${task.id}`;
    const expandedTaskKeys = new Set([taskKey]);
    let settledExpanded = false;
    let settledVisibleCount = 1;
    const revealShelf = (_shelf: "snoozed" | "settled", count: number) => {
      settledExpanded = true;
      settledVisibleCount = Math.max(settledVisibleCount, count);
    };
    calls.setExpanded.mockImplementation((_ref: unknown, expanded: boolean) => {
      if (expanded) expandedTaskKeys.add(taskKey);
      else expandedTaskKeys.delete(taskKey);
    });
    const updateInventory = async () => {
      const inventory = buildTaskSidebarInventory({
        tasks,
        threads: [],
        now: task.updatedAt,
        taskCapableEnvironmentIds: new Set([task.environmentId]),
        selectedTaskKey: taskKey,
        expandedTaskKeys,
        settledExpanded,
        settledVisibleCount,
      });
      const item = inventory.items.find(
        (item) => item.kind === "task" && item.taskKey === taskKey,
      )!;
      if (item.kind !== "task") throw new Error("Expected selected task");
      await render({
        task: selected,
        section: "settled",
        expanded: item.expanded,
        retainedShelfVisibleCount: item.retainedShelfVisibleCount,
        revealShelf,
        liveCount: 0,
        settledCount: 0,
      });
      return inventory.items
        .filter((item) => item.kind === "task")
        .map((item) => item.taskRef.taskId);
    };
    // The selected task is retained even though its shelf is collapsed and it has no children.
    expect(await updateInventory()).toEqual([task.id]);
    expect(expandedTaskKeys.has(taskKey)).toBe(true);
    const row = () =>
      renderer.root.findByProps({ role: "button", "aria-expanded": props.expanded });
    expect(row().props["aria-expanded"]).toBe(false);
    await act(() => row().props.onClick());
    expect(await updateInventory()).toEqual(["newest", "middle", task.id]);
    expect(row().props["aria-expanded"]).toBe(true);
    await act(() => row().props.onClick());
    await updateInventory();
    expect(row().props["aria-expanded"]).toBe(false);
    expect(expandedTaskKeys.has(taskKey)).toBe(false);
  });

  it("updates settle availability on a status transition without new row props", async () => {
    await render();
    const settleButton = () => renderer.root.findByProps({ "aria-label": "Settle task" });
    expect(settleButton().props["aria-disabled"]).toBeUndefined();
    // The mocked transport atom remains writable; the component still uses its real subscription.
    const status = environmentShell.statusAtom(task.environmentId) as Atom.Writable<string, string>;
    await act(() => registry.set(status, "cached"));
    expect(calls.render).toHaveBeenCalledTimes(2);
    expect(settleButton().props["aria-disabled"]).toBe(true);
    await act(() => registry.set(status, "live"));
    expect(settleButton().props["aria-disabled"]).toBeUndefined();
    await render({ settleBlocked: true });
    expect(settleButton().props["aria-disabled"]).toBe(true);
  });
});
