import { describe, expect, it } from "bun:test";

import { prepareTerminalViewport, TUI_RENDERER_CONFIG } from "./terminalStartup.ts";

describe("TUI terminal startup", () => {
  it("Given the TUI starts, then it always requests a full alternate screen with mouse scrolling", () => {
    expect(TUI_RENDERER_CONFIG.screenMode).toBe("alternate-screen");
    expect(TUI_RENDERER_CONFIG.useMouse).toBe(true);
    expect(TUI_RENDERER_CONFIG.enableMouseMovement).toBe(false);
  });

  it("Given tmux is showing pane history, when the TUI starts, then it returns that pane to the live screen", () => {
    const calls: ReadonlyArray<string>[] = [];

    prepareTerminalViewport({ TMUX: "/tmp/tmux/default,1,0", TMUX_PANE: "%42" }, (args) =>
      calls.push(args),
    );

    expect(calls).toEqual([["copy-mode", "-q", "-t", "%42"]]);
  });

  it("Given the TUI is outside tmux, when it starts, then it does not invoke tmux", () => {
    let called = false;

    prepareTerminalViewport({}, () => {
      called = true;
    });

    expect(called).toBe(false);
  });
});
