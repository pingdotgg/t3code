import { describe, expect, it } from "vite-plus/test";

import { shouldFocusTerminalAfterSetup } from "./terminal-focus";

describe("shouldFocusTerminalAfterSetup", () => {
  it("focuses the active terminal on its first setup", () => {
    expect(
      shouldFocusTerminalAfterSetup({
        autoFocus: true,
        hasMounted: false,
        restorePreviousTerminalFocus: false,
      }),
    ).toBe(true);
  });

  it("does not steal focus when terminal style causes a remount", () => {
    expect(
      shouldFocusTerminalAfterSetup({
        autoFocus: true,
        hasMounted: true,
        restorePreviousTerminalFocus: false,
      }),
    ).toBe(false);
  });

  it("restores focus when the terminal itself was focused before remount", () => {
    expect(
      shouldFocusTerminalAfterSetup({
        autoFocus: false,
        hasMounted: true,
        restorePreviousTerminalFocus: true,
      }),
    ).toBe(true);
  });
});
