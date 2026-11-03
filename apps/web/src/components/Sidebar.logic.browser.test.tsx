import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { useSnoozeWakeClock, useThreadJumpHintsVisible } from "./Sidebar.logic";

const MOUNTED_AT_MS = Date.parse("2026-10-24T08:00:00.000Z");

function WakeClock(props: { readonly threads: ReadonlyArray<{ readonly snoozedUntil: string }> }) {
  return <output>{useSnoozeWakeClock(props.threads)}</output>;
}

describe("useSnoozeWakeClock", () => {
  it("settles in one step when many distinct wakes passed during a sleep", async () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(MOUNTED_AT_MS);
    // More distinct wakes than React's 25 render-phase re-render limit.
    const threads = Array.from({ length: 40 }, (_, index) => ({
      snoozedUntil: new Date(MOUNTED_AT_MS + 1 + index * 60_000).toISOString(),
    }));
    await using screen = await render(<WakeClock threads={threads} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent(String(MOUNTED_AT_MS));

    // The machine resumes after every wake has passed; the first wake's timer fires late.
    const resumedAtMs = MOUNTED_AT_MS + 24 * 60 * 60_000;
    now.mockReturnValue(resumedAtMs);

    // The clock lands on the last elapsed wake, so every woken thread has left the shelf.
    const lastWakeMs = MOUNTED_AT_MS + 1 + 39 * 60_000;
    await expect.element(screen.getByRole("status")).toHaveTextContent(String(lastWakeMs));
  });
});

function JumpHints(props: { readonly held: boolean }) {
  return <output>{useThreadJumpHintsVisible(props.held) ? "shown" : "hidden"}</output>;
}

describe("useThreadJumpHintsVisible", () => {
  it("waits for the delay again on a second hold", async () => {
    // The first render reads the clock.
    using _timers = fakeTimers({ now: 0 });
    await using screen = await render(<JumpHints held />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByRole("status")).toHaveTextContent("shown");

    await screen.rerender(<JumpHints held={false} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(1_000));

    await screen.rerender(<JumpHints held />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByRole("status")).toHaveTextContent("shown");
  });
});
