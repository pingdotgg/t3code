import { describe, expect, it } from "bun:test";

import {
  ensureColorCapabilityEnv,
  prepareTerminalViewport,
  TUI_RENDERER_CONFIG,
} from "./terminalStartup.ts";

describe("TUI terminal startup", () => {
  it("Given the TUI starts, then it always requests a full alternate screen with mouse scrolling", () => {
    expect(TUI_RENDERER_CONFIG.screenMode).toBe("alternate-screen");
    expect(TUI_RENDERER_CONFIG.useMouse).toBe(true);
    expect(TUI_RENDERER_CONFIG.enableMouseMovement).toBe(false);
  });

  it("Given an SSH session, then colour env still reaches the native capability detection", () => {
    // Remote-flagged renderers forward no env by default, which discards
    // COLORTERM/TERM and flattens themed ANSI slots to the baked palette.
    expect(TUI_RENDERER_CONFIG.forwardEnvKeys).toContain("TERM");
    expect(TUI_RENDERER_CONFIG.forwardEnvKeys).toContain("COLORTERM");
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

describe("ensureColorCapabilityEnv", () => {
  it("Given a Ghostty TERM without COLORTERM, then it advertises truecolor", () => {
    const env: NodeJS.ProcessEnv = { TERM: "xterm-ghostty" };
    ensureColorCapabilityEnv(env);
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("Given TERM_PROGRAM names a truecolor terminal, then it advertises truecolor", () => {
    const env: NodeJS.ProcessEnv = { TERM: "xterm-256color", TERM_PROGRAM: "WezTerm" };
    ensureColorCapabilityEnv(env);
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("Given the shell already set COLORTERM, then it is left untouched", () => {
    const env: NodeJS.ProcessEnv = { TERM: "xterm-ghostty", COLORTERM: "24bit" };
    ensureColorCapabilityEnv(env);
    expect(env.COLORTERM).toBe("24bit");
  });

  it("Given an unrecognised terminal, then no truecolor claim is invented", () => {
    const env: NodeJS.ProcessEnv = { TERM: "xterm-256color" };
    ensureColorCapabilityEnv(env);
    expect(env.COLORTERM).toBeUndefined();
  });
});
