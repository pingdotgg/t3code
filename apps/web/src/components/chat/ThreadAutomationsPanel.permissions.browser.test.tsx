import {
  EnvironmentId,
  ThreadId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskListResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  toggle: vi.fn(),
  run: vi.fn(),
  listResult: { tasks: [] } as ScheduledTaskListResult,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
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
  useEnvironmentQuery: (() => ({ data: state.listResult, error: null })) as never,
}));

import { act, render as renderUi } from "../../../test/render";
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

async function setup() {
  state.allowed = true;
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  state.listResult = { tasks: [task] };

  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  const container = screen.container;
  async function renderPanel() {
    await act(
      async () =>
        await screen.rerender(
          <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
        ),
    );
  }

  const byLabel = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  const environment = stack.move();
  return {
    renderPanel,
    byLabel,
    container,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}
it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  await using fixture = await setup();
  const { renderPanel, byLabel } = fixture;
  state.allowed = allowed;
  await renderPanel();
  await act(async () => byLabel("Run Daily review now").click());
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await using fixture = await setup();
  const { renderPanel, byLabel } = fixture;
  await renderPanel();
  state.allowed = false;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).not.toHaveBeenCalled();

  state.allowed = true;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).toHaveBeenCalledOnce();
});

it("labels fixed times with a short server zone and preserves labels from older servers", async () => {
  await using fixture = await setup();
  const { renderPanel, container } = fixture;
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
  const labels = () =>
    Array.from(container.querySelectorAll("li p.text-2xs"), (row) => row.textContent);

  state.listResult = { tasks, timeZone: "America/Los_Angeles" };
  await renderPanel();
  expect(labels()[0]).toMatch(/^Daily at 09:00 (P[DS]T|GMT-)/);
  expect(labels()[0]).not.toContain("America/");
  expect(labels().slice(1)).toEqual(["Every 1 min", "On webhook"]);

  state.listResult = { tasks, timeZone: "Etc/UTC" };
  await renderPanel();
  expect(labels()).toEqual(["Daily at 09:00 UTC", "Every 1 min", "On webhook"]);

  state.listResult = { tasks, timeZone: "UTC" };
  await renderPanel();
  expect(labels()).toEqual(["Daily at 09:00 UTC", "Every 1 min", "On webhook"]);

  state.listResult = { tasks };
  await renderPanel();
  expect(labels()).toEqual(["Daily at 09:00", "Every 1 min", "On webhook"]);
});
