import { describe, expect, it } from "vite-plus/test";

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
  suppressNativeTerminalCloseShortcut,
  type TerminalCloseShortcutEvent,
} from "./terminalCloseShortcut";

const keybindings = [
  {
    command: "terminal.close",
    shortcut: {
      key: "w",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    whenAst: { type: "identifier", name: "terminalFocus" },
  },
] satisfies ResolvedKeybindingsConfig;

type KeyboardEventOverrides = Partial<
  Pick<
    TerminalCloseShortcutEvent,
    "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat"
  >
>;

function keyboardEvent(
  overrides: KeyboardEventOverrides = {},
): TerminalCloseShortcutEvent & { readonly defaultPrevented: boolean } {
  let defaultPrevented = false;
  return {
    key: "w",
    code: "KeyW",
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };
}

describe("terminal close shortcut guards", () => {
  it("prevents the browser default for a deliberate terminal close", () => {
    const event = keyboardEvent();

    expect(preventTerminalCloseShortcut(event, keybindings, "Linux x86_64")).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps held close repeats from closing the browser after the last terminal unmounts", () => {
    const firstPress = keyboardEvent();
    expect(preventTerminalCloseShortcut(firstPress, keybindings, "Linux x86_64")).toBe(true);

    let browserCloseCount = 0;
    for (const repeat of [true, true, true]) {
      const event = keyboardEvent({ repeat });
      preventRepeatedTerminalCloseShortcut(event, keybindings, "Linux x86_64");
      if (!event.defaultPrevented) browserCloseCount += 1;
    }

    expect(browserCloseCount).toBe(0);
    expect(preventRepeatedTerminalCloseShortcut(keyboardEvent(), keybindings, "Linux x86_64")).toBe(
      false,
    );
  });

  it("leaves a non-repeated window close and unrelated repeats alone", () => {
    const deliberateWindowClose = keyboardEvent({ repeat: false });
    const unrelatedRepeat = keyboardEvent({ key: "q", code: "KeyQ", repeat: true });

    expect(
      preventRepeatedTerminalCloseShortcut(deliberateWindowClose, keybindings, "Linux x86_64"),
    ).toBe(false);
    expect(deliberateWindowClose.defaultPrevented).toBe(false);
    expect(preventRepeatedTerminalCloseShortcut(unrelatedRepeat, keybindings, "Linux x86_64")).toBe(
      false,
    );
    expect(unrelatedRepeat.defaultPrevented).toBe(false);
  });
});

describe("suppressNativeTerminalCloseShortcut", () => {
  it("suppresses held repeats and pending-confirm closes for native owners", () => {
    for (const owner of ["drawer", "right-panel", null] as const) {
      const repeat = keyboardEvent({ repeat: true });
      expect(
        suppressNativeTerminalCloseShortcut(repeat, keybindings, owner, false, "Linux x86_64"),
      ).toBe(true);
      expect(repeat.defaultPrevented).toBe(true);

      const confirmClose = keyboardEvent();
      expect(
        suppressNativeTerminalCloseShortcut(confirmClose, keybindings, owner, true, "Linux x86_64"),
      ).toBe(true);
      expect(confirmClose.defaultPrevented).toBe(true);

      const unrelated = keyboardEvent({ key: "q", code: "KeyQ", repeat: true });
      expect(
        suppressNativeTerminalCloseShortcut(unrelated, keybindings, owner, true, "Linux x86_64"),
      ).toBe(false);
      expect(unrelated.defaultPrevented).toBe(false);
    }
  });

  it("leaves first presses, held repeats and pending-confirm closes to an extension's keymap", () => {
    for (const repeat of [false, true, true]) {
      const event = keyboardEvent({ repeat });
      expect(
        suppressNativeTerminalCloseShortcut(event, keybindings, "extension", false, "Linux x86_64"),
      ).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }

    // A pending native close confirmation must not swallow the extension's key.
    const duringConfirm = keyboardEvent();
    expect(
      suppressNativeTerminalCloseShortcut(
        duringConfirm,
        keybindings,
        "extension",
        true,
        "Linux x86_64",
      ),
    ).toBe(false);
    expect(duringConfirm.defaultPrevented).toBe(false);
  });
});
