import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

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

const card = (value: WorktreeSetupSnapshot) => (
  <WorktreeSetupCard snapshot={value} onCancel={null} onWorkLocally={null} onOpenTerminal={null} />
);

it("separates a failed stage from its detail when no snapshot error exists", async () => {
  const failed = snapshot({
    phase: "failed",
    stages: [
      {
        id: "setup-script",
        status: "failed",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:05.000Z",
        percent: null,
        detail: "exited with 1",
        tail: [],
      },
    ],
  });
  await using screen = await render(card(failed));
  expect(screen.getByRole("region", { name: "Worktree setup" }).element().textContent).toContain(
    "Run setup script failed: exited with 1",
  );
});

it("ticks the running setup duration", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  await using screen = await render(card(snapshot({})));
  // Assert synchronously: expect.element polls on timers these tests fake.
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Check out files");
  expect(section.element().textContent).toContain("Working for 10s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Working for 15s");
});

it("keeps the failed setup duration at its end", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const failed = snapshot({ phase: "failed", endedAt: "2026-10-26T12:00:05.000Z" });
  await using screen = await render(card(failed));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("took 5s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("took 5s");
});
