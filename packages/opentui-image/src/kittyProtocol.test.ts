import { describe, expect, it } from "bun:test";

import { encodeKittyCommand } from "./kittyProtocol.ts";

describe("Kitty command transport", () => {
  it("leaves direct commands unchanged", () => {
    expect(encodeKittyCommand("\x1b]5522;type=read\x1b\\")).toBe("\x1b]5522;type=read\x1b\\");
  });

  it("escapes commands for tmux passthrough", () => {
    expect(encodeKittyCommand("\x1b]5522;type=read\x1b\\", "tmux")).toBe(
      "\x1bPtmux;\x1b\x1b]5522;type=read\x1b\x1b\\\x1b\\",
    );
  });
});
