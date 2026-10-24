import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";

const spoken = () =>
  [...document.querySelectorAll('body > [aria-live="polite"]')]
    .map((region) => region.textContent)
    .join("");

describe("SidebarThreadUndoNotice", () => {
  it("speaks the notice, and drops it when the notice clears before it is spoken", async () => {
    using _notice = { [Symbol.dispose]: () => useThreadUndoNotice.setState({ notice: null }) };
    await using _screen = await render(<SidebarThreadUndoNotice />);
    using _timers = fakeTimers();
    const showSettled = () =>
      act(async () =>
        useThreadUndoNotice.setState({
          notice: { action: "Settled", count: 1, undo: async () => {} },
        }),
      );

    await showSettled();
    await act(async () => vi.advanceTimersByTime(300));
    expect(spoken()).toMatch(/^Settled 1 thread, /);

    await act(async () => useThreadUndoNotice.setState({ notice: null }));
    for (const region of document.querySelectorAll('body > [aria-live="polite"]')) {
      region.textContent = "";
    }
    await showSettled();
    await act(async () => useThreadUndoNotice.setState({ notice: null }));
    await act(async () => vi.advanceTimersByTime(300));
    expect(spoken()).toBe("");
  });
});
