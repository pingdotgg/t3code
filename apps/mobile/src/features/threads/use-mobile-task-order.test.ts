import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { taskOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import { EnvironmentId, TaskId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useMobileTaskOrder } from "./use-mobile-task-order";

const state = vi.hoisted(() => ({ values: new Map<string, unknown>(), dispatch: vi.fn() }));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: string) => state.values.get(atom) }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) => state.values.get(atom),
    set: (atom: string, value: unknown) => state.values.set(atom, value),
  },
}));
vi.mock("../../state/tasks", () => ({
  environmentTasks: { tasksAtom: "tasks" },
  taskEnvironment: { reorderPin: "taskPin", reorderActive: "taskActive" },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: "threads" },
  threadEnvironment: { reorderPin: "threadPin", reorderActive: "threadActive" },
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: "queued" }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.dispatch }));
vi.mock("../../state/thread-order", () => ({
  getPendingThreadOrder: () => null,
  threadDropBusyAtom: "busy",
}));

const environmentId = EnvironmentId.make("env");
const task: EnvironmentTask = {
  environmentId,
  id: TaskId.make("first"),
  name: "First",
  description: null,
  primaryProjectId: ProjectId.make("project"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: "ab",
  createdAt: "2026-06-02T00:00:00.000Z",
  updatedAt: "2026-06-02T00:00:00.000Z",
};
const moved = { ...task, id: TaskId.make("second"), activeOrderKey: "ac" };
beforeEach(() => {
  state.values.clear();
  state.values.set("tasks", [task, moved]);
  state.values.set("threads", []);
  state.values.set(
    "configs",
    new Map([[environmentId, { environment: { capabilities: { tasks: true } } }]]),
  );
  state.values.set("queued", new Set());
  state.values.set("busy", false);
  state.dispatch.mockReset().mockResolvedValue({ _tag: "Success" });
});

describe("mobile task move execution", () => {
  it("dispatches a valid fresh plan and releases the busy flag", async () => {
    expect(await useMobileTaskOrder().move(taskOrderRow(moved), "up")).toBe(true);
    expect(state.dispatch).toHaveBeenCalledOnce();
    expect(state.dispatch.mock.calls[0]?.[0].input.taskId).toBe(moved.id);
    expect(state.values.get("busy")).toBe(false);
  });
  it.each(["removed", "archived", "capability"])(
    "revalidates %s changes after the row was displayed",
    async (change) => {
      const order = useMobileTaskOrder();
      if (change === "removed") state.values.set("tasks", [task]);
      if (change === "archived")
        state.values.set("tasks", [task, { ...moved, archivedAt: task.createdAt }]);
      if (change === "capability") state.values.set("configs", new Map());
      expect(await order.move(taskOrderRow(moved), "up")).toBe(false);
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(state.values.get("busy")).toBe(false);
    },
  );
});
