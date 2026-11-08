import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig, isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  useShouldShowThreadJumpHints,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
} from "./Sidebar.logic";

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

const ROUTE_THREAD_REF = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-1"),
};

function ShouldShowJumpHints(props: { readonly keybindings: ResolvedKeybindingsConfig }) {
  const shown = useShouldShowThreadJumpHints(props.keybindings, ROUTE_THREAD_REF);
  return <output>{shown ? "shown" : "hidden"}</output>;
}

describe("useShouldShowThreadJumpHints", () => {
  it("follows the held modifier, terminal focus and the route thread's terminal", async () => {
    using stack = new DisposableStack();
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(ROUTE_THREAD_REF, false));
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+1", command: "thread.jump.1", when: "terminalOpen" },
    ]);
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await using screen = await render(<ShouldShowJumpHints keybindings={keybindings} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    const output = screen.getByRole("status");

    await userEvent.keyboard(`{${modifier}>}`);
    await expect.element(output).toHaveTextContent("hidden");
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(ROUTE_THREAD_REF, true));
    await expect.element(output).toHaveTextContent("shown");
    await act(() => terminalInput.focus());
    await expect.element(output).toHaveTextContent("hidden");
    await act(() => terminalInput.blur());
    await expect.element(output).toHaveTextContent("shown");
    await userEvent.keyboard(`{/${modifier}}`);
    await expect.element(output).toHaveTextContent("hidden");
  });
});
