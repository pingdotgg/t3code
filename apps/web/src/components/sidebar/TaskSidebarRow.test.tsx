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
      { task: { ...task, name: "Renamed" } },
      { project: { ...project, title: "Renamed project" } },
      { section: "snoozed" },
    ];
    for (const [index, change] of changes.entries()) {
      await render(change);
      expect(calls.render).toHaveBeenCalledTimes(index + 2);
    }
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
