import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import "../../index.css";

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

it("ticks the running stage while finished stages keep their duration", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  await using screen = await render(card(snapshot({})));
  // Assert synchronously: expect.element polls on timers these tests fake.
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files7s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files12s");
});

it("stops a stage interrupted by the setup ending at the setup's end", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const failed = snapshot({ phase: "failed", endedAt: "2026-10-26T12:00:05.000Z" });
  await using screen = await render(card(failed));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Check out files2s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Check out files2s");
});

it("keeps signaling a running setup beyond its first animation cycle", async () => {
  await using screen = await render(card(snapshot({})));
  const section = screen.getByRole("region", { name: "Worktree setup" }).element();
  const indicator = section.querySelector<HTMLElement>(".live-activity-focus")!;
  await vi.waitFor(() => expect(indicator.getAnimations()[0]?.playState).toBe("running"));
  const animation = indicator.getAnimations()[0]!;
  animation.pause();
  animation.currentTime = 5_500;
  const previousTransform = getComputedStyle(indicator).transform;
  animation.currentTime = 6_000;
  expect(getComputedStyle(indicator).transform).not.toBe(previousTransform);

  await screen.rerender(
    card(
      snapshot({
        phase: "done",
        endedAt: "2026-10-26T12:00:10.000Z",
        stages: [],
      }),
    ),
  );
  expect(section.querySelector(".live-activity-focus")).toBeNull();
});
