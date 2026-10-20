import {
  EnvironmentId,
  ThreadId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskListResult,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ allowed: true, toggle: vi.fn(), run: vi.fn() }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
// The panel reads the run permission through an atom; the grant is the boundary under test.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.allowed) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled ? state.toggle : state.run) as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: listResult, error: null })) as never,
}));

import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const task = {
  id: ScheduledTaskId.make("task"),
  threadId,
  title: "Daily review",
  enabled: true,
  schedule: { type: "interval", everyMs: 60000 },
  lastRunStatus: "never",
  nextRunAt: null,
} as ScheduledTask;
let listResult: ScheduledTaskListResult & { timeZone?: string };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  listResult = { tasks: [task] };
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderPanel() {
  await act(async () =>
    root.render(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />),
  );
}

const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  state.allowed = allowed;
  await renderPanel();
  await act(async () => byLabel("Run Daily review now").click());
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await renderPanel();
  state.allowed = false;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).not.toHaveBeenCalled();

  state.allowed = true;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).toHaveBeenCalledOnce();
});

it("labels fixed times with the server zone and preserves labels from older servers", async () => {
  const tasks: ScheduledTask[] = [
    { ...task, schedule: { type: "fixed_time", timeOfDay: "09:00" } },
    { ...task, id: ScheduledTaskId.make("interval"), title: "Interval review" },
    {
      ...task,
      id: ScheduledTaskId.make("webhook"),
      title: "Webhook review",
      schedule: { type: "webhook", signature: null },
    },
  ];
  const labels = () => Array.from(container.querySelectorAll("li p"), (row) => row.textContent);

  listResult = { tasks, timeZone: "Asia/Kolkata" };
  await renderPanel();
  expect(labels()).toEqual(["Daily at 09:00 Asia/Kolkata", "Every 1 min", "On webhook"]);

  listResult = { tasks, timeZone: "Etc/UTC" };
  await renderPanel();
  expect(labels()).toEqual(["Daily at 09:00 UTC", "Every 1 min", "On webhook"]);

  listResult = { tasks, timeZone: "UTC" };
  await renderPanel();
  expect(labels()).toEqual(["Daily at 09:00 UTC", "Every 1 min", "On webhook"]);

  listResult = { tasks };
  await renderPanel();
  expect(labels()).toEqual(["Daily at 09:00", "Every 1 min", "On webhook"]);
});
