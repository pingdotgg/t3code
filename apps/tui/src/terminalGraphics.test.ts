import { describe, expect, it } from "bun:test";

import { isKnownKittyGraphicsTerminal } from "./terminalGraphics.ts";

describe("Kitty graphics terminal detection", () => {
  it("recognizes direct Ghostty, Kitty, WezTerm, and Konsole markers", () => {
    expect(isKnownKittyGraphicsTerminal({ TERM: "xterm-ghostty" })).toBe(true);
    expect(isKnownKittyGraphicsTerminal({ KITTY_WINDOW_ID: "1" })).toBe(true);
    expect(isKnownKittyGraphicsTerminal({ WEZTERM_PANE: "2" })).toBe(true);
    expect(isKnownKittyGraphicsTerminal({ KONSOLE_VERSION: "250400" })).toBe(true);
  });

  it("uses tmux's saved outer environment when the pane identifies only as tmux", () => {
    expect(
      isKnownKittyGraphicsTerminal(
        { TERM: "tmux-256color", TERM_PROGRAM: "tmux" },
        "TERM=xterm-ghostty\nTERM_PROGRAM=ghostty\n",
      ),
    ).toBe(true);
  });

  it("does not opt an unknown tmux client into Kitty graphics", () => {
    expect(
      isKnownKittyGraphicsTerminal(
        { TERM: "tmux-256color", TERM_PROGRAM: "tmux" },
        "TERM=xterm-256color\nTERM_PROGRAM=Alacritty\n",
      ),
    ).toBe(false);
  });
});
