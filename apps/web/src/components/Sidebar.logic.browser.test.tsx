import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig, isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { registerModelPickerContent } from "../modelPickerVisibility";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
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

const ROUTE_THREAD_REF = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-1"),
};

function JumpHints(props: { readonly keybindings: ResolvedKeybindingsConfig }) {
  const shown = useThreadJumpHintsVisible(props.keybindings, ROUTE_THREAD_REF);
  return <output>{shown ? "shown" : "hidden"}</output>;
}

describe("useThreadJumpHintsVisible", () => {
  it("waits for the delay again on a second hold", async () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+1", command: "thread.jump.1" },
    ]);
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await using screen = await render(<JumpHints keybindings={keybindings} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    using _timers = fakeTimers();
    const output = screen.getByRole("status");

    await userEvent.keyboard(`{${modifier}>}`);
    await expect.element(output).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    await expect.element(output).toHaveTextContent("shown");

    await userEvent.keyboard(`{/${modifier}}`);
    await expect.element(output).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));

    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1));
    await expect.element(output).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(1));
    await expect.element(output).toHaveTextContent("shown");
    await userEvent.keyboard(`{/${modifier}}`);
  });

  it("follows terminal focus and the route thread's terminal while the modifier is held", async () => {
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
    await using screen = await render(<JumpHints keybindings={keybindings} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    using _timers = fakeTimers();
    const output = screen.getByRole("status");

    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
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

  it("returns when the model picker closes while the modifier is still held", async () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+1", command: "thread.jump.1", when: "!modelPickerOpen" },
    ]);
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await using screen = await render(<JumpHints keybindings={keybindings} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    using _timers = fakeTimers();
    const output = screen.getByRole("status");

    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    await expect.element(output).toHaveTextContent("shown");
    let unregisterModelPicker = () => {};
    await act(() => {
      unregisterModelPicker = registerModelPickerContent();
    });
    await expect.element(output).toHaveTextContent("hidden");
    await act(() => unregisterModelPicker());
    await expect.element(output).toHaveTextContent("shown");
    await userEvent.keyboard(`{/${modifier}}`);
  });

  it("shows after the delay for a jump binding without a modifier", async () => {
    const keybindings = compileResolvedKeybindingsConfig([{ key: "f1", command: "thread.jump.1" }]);
    // Mounting starts the hold delay.
    using _timers = fakeTimers();
    await using screen = await render(<JumpHints keybindings={keybindings} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    const output = screen.getByRole("status");

    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    await expect.element(output).toHaveTextContent("shown");
  });
});
