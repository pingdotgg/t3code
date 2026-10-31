import { EnvironmentId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    runScheduledTaskNow: { permissionAtom: () => true },
    setScheduledTaskEnabled: {},
    deleteScheduledTask: {},
  },
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));

import { useScheduledTaskActions } from "./scheduled-task-actions";

const task = (id: string) =>
  ({
    id: ScheduledTaskId.make(id),
    enabled: false,
    updatedAt: "2026-10-30T07:00:00.000Z",
  }) as ScheduledTask;

function Tasks(props: { readonly tasks: ReadonlyArray<ScheduledTask> }) {
  const actions = useScheduledTaskActions(EnvironmentId.make("environment"));
  return props.tasks.map((task) => (
    <button key={task.id} onClick={() => void actions.act(task, "toggle")}>
      {`${task.id}: ${actions.isEnabled(task)}`}
    </button>
  ));
}

it("retains each task's toggle until its live version arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const tasks = [task("a"), task("b")];
  try {
    await act(async () => root.render(<Tasks tasks={tasks} />));
    await act(async () => container.querySelectorAll("button")[0]!.click());
    expect(container.textContent).toBe("a: trueb: false");
    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(container.textContent).toBe("a: trueb: true");
    await act(async () =>
      root.render(
        <Tasks
          tasks={[
            { ...tasks[0]!, enabled: false, updatedAt: "2026-10-30T07:05:00.000Z" },
            tasks[1]!,
          ]}
        />,
      ),
    );
    expect(container.textContent).toBe("a: falseb: true");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
