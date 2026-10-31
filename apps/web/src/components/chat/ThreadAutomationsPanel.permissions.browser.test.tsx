import { EnvironmentId, ThreadId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({ allowed: true, toggle: vi.fn(), run: vi.fn() }));
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
  useEnvironmentQuery: (() => ({ data: { tasks: [task] }, error: null })) as never,
}));

import { act, fakeTimers, render as renderUi } from "../../../test/render";
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
  nextRunAt: "2026-10-18T12:05:00.000Z",
} as ScheduledTask;

async function setup() {
  state.allowed = true;
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });

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
    await userEvent.click(container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!);
  }

  const byLabel = (label: string) =>
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  const environment = stack.move();
  return { screen, renderPanel, byLabel, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}
it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  await using fixture = await setup();
  const { renderPanel } = fixture;
  state.allowed = allowed;
  await renderPanel();
  const run = page.getByRole("menuitem", { name: "Run Daily review now" }).element();
  expect(run).toBeDefined();
  expect(run.getAttribute("aria-disabled")).toBe(allowed ? null : "true");
  await act(async () => run.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await using fixture = await setup();
  const { renderPanel, byLabel, screen } = fixture;
  await renderPanel();
  const toggle = byLabel("Pause Daily review");
  expect(toggle).toBeDefined();
  state.allowed = false;
  await act(async () => toggle.click());
  expect(state.toggle).not.toHaveBeenCalled();

  state.allowed = true;
  if (!document.querySelector('[role="menu"]')) {
    await userEvent.click(screen.container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!);
  }
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).toHaveBeenCalledOnce();
});

it("updates the next-run label while the task stays unchanged", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
  await using fixture = await setup();
  const { screen } = fixture;
  const { container } = screen;
  await screen.rerender(
    <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
  );
  expect(container.textContent).toContain("in 5m");

  await act(async () => vi.advanceTimersByTime(60_000));
  expect(container.textContent).toContain("in 4m");
});
