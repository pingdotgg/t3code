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
  it("reads a newer preference snapshot when the next action runs", () => {
    const toggle = useMobileTaskListActions();
    toggle("task");
    state.preferences = AsyncResult.success({ collapsedTaskKeys: ["new-other"] });
    toggle("task");
    expect(state.update).toHaveBeenLastCalledWith({ collapsedTaskKeys: ["new-other", "task"] });
  });
});
