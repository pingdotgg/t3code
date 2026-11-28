import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { WorktreeSetupRows } from "./WorktreeSetupCard";

const NOW = new Date("2026-10-26T12:00:10.000Z");

function snapshot(overrides: Partial<WorktreeSetupSnapshot>): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.make("thread-1"),
    phase: "running",
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: null,
    branch: "t3/feature",
    baseRef: "main",
    worktreePath: "/repo/.t3/worktrees/feature",
    setupScript: null,
    stages: [
      {
        id: "fetch",
        status: "done",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:03.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
      {
        id: "checkout",
        status: "running",
        startedAt: "2026-10-26T12:00:03.000Z",
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
    error: null,
    sequence: 1,
    ...overrides,
  };
}

const rows = (value: WorktreeSetupSnapshot) => (
  <WorktreeSetupRows snapshot={value} onOpenTerminal={null} />
);

it("ticks the running stage duration", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  await using screen = await render(rows(snapshot({})));
  // Assert synchronously: expect.element polls on timers these tests fake.
  const checkout = screen
    .getByRole("region", { name: "Worktree setup" })
    .element()
    .querySelector('[data-worktree-setup-stage="checkout"]');

  expect(checkout?.textContent).toContain("Checking out t3/feature");
  expect(checkout?.textContent).toContain("7s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(checkout?.textContent).toContain("12s");
});

it("keeps the finished setup duration at its end", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const done = snapshot({
    phase: "done",
    endedAt: "2026-10-26T12:00:05.000Z",
    stages: snapshot({}).stages.map((stage) => ({
      ...stage,
      status: "done",
      endedAt: stage.endedAt ?? "2026-10-26T12:00:05.000Z",
    })),
  });
  await using screen = await render(rows(done));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Set up worktree t3/feature5s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Set up worktree t3/feature5s");
});

it("shows a failed row with the error when setup fails without a failed visible stage", async () => {
  const failed = snapshot({
    phase: "failed",
    endedAt: "2026-10-26T12:00:04.000Z",
    error: "fatal: repository not found",
    stages: [
      {
        id: "fetch",
        status: "done",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:02.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
      {
        id: "agent",
        status: "failed",
        startedAt: "2026-10-26T12:00:02.000Z",
        endedAt: "2026-10-26T12:00:04.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
    ],
  });
  await using screen = await render(rows(failed));
  const row = screen.getByRole("button", { name: "Worktree setup failed, setup step failed" });
  await expect.element(row).toBeVisible();
  await userEvent.click(row);
  await expect.element(screen.getByText("fatal: repository not found")).toBeVisible();
});
