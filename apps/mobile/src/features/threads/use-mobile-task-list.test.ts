import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useMobileTaskListActions } from "./use-mobile-task-list";

const state = vi.hoisted(() => ({ preferences: {} as unknown, update: vi.fn() }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomSet: () => state.update }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => state.preferences } }));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "update",
}));
vi.mock("../../state/tasks", () => ({ useTasks: vi.fn() }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));

beforeEach(() => {
  state.preferences = AsyncResult.success({
    collapsedTaskKeys: ["other"],
    expandedTaskShelfKeys: ["settled"],
  });
  state.update.mockReset();
});

describe("task expansion actions", () => {
  it("preserves unrelated preferences across rapid toggles before persistence responds", () => {
    const toggle = useMobileTaskListActions();
    toggle("task");
    toggle("task");
    toggle("settled", true);
    expect(state.update.mock.calls).toEqual([
      [{ collapsedTaskKeys: ["other", "task"] }],
      [{ collapsedTaskKeys: ["other"] }],
      [{ expandedTaskShelfKeys: [] }],
    ]);
  });
  it("explicitly expands retained parked tasks without inverting saved choices or losing other maps", () => {
    const preferences = {
      collapsedTaskKeys: ["local:active", "parked:remote:task", "parked:local:task"],
      expandedTaskShelfKeys: ["remote:task", "local:task"],
    };
    state.preferences = AsyncResult.success(preferences);
    const toggle = useMobileTaskListActions();
    // Retention alone leaves the saved maps untouched.
    expect(state.update).not.toHaveBeenCalled();
    toggle("parked:local:task", false, true);
    toggle("parked:local:task", false, true);
    expect(state.update).toHaveBeenLastCalledWith({
      collapsedTaskKeys: preferences.collapsedTaskKeys,
    });
    // A subsequent ordinary press still collapses, using the latest local choice.
    toggle("parked:local:task");
    expect(state.update).toHaveBeenLastCalledWith({
      collapsedTaskKeys: ["local:active", "parked:remote:task"],
    });
    // Fresh persistence may have no saved expansion for this task. Explicit reveal adds it.
    state.preferences = AsyncResult.success({
      ...preferences,
      collapsedTaskKeys: ["parked:remote:task"],
    });
    toggle("parked:local:task", false, true);
    expect(state.update).toHaveBeenLastCalledWith({
      collapsedTaskKeys: ["parked:remote:task", "parked:local:task"],
    });
    expect(preferences.expandedTaskShelfKeys).toEqual(["remote:task", "local:task"]);
  });
  it("reads a newer preference snapshot when the next action runs", () => {
    const toggle = useMobileTaskListActions();
    toggle("task");
    state.preferences = AsyncResult.success({ collapsedTaskKeys: ["new-other"] });
    toggle("task");
    expect(state.update).toHaveBeenLastCalledWith({ collapsedTaskKeys: ["new-other", "task"] });
  });
});

it("keeps show-all choices separate while toggling both disclosures", () => {
  const toggle = useMobileTaskListActions();
  toggle("task", "all", true);
  toggle("task");
  toggle("task", true);
  toggle("task");
  toggle("remote:task", "all", true);
  toggle("task", "all", false);
  expect(state.update.mock.calls).toEqual([
    [{ showAllTaskKeys: ["task"] }],
    [{ collapsedTaskKeys: ["other", "task"] }],
    [{ expandedTaskShelfKeys: ["settled", "task"] }],
    [{ collapsedTaskKeys: ["other"] }],
    [{ showAllTaskKeys: ["task", "remote:task"] }],
    [{ showAllTaskKeys: ["remote:task"] }],
  ]);
});
