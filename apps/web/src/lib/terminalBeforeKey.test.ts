import { describe, expect, it } from "vite-plus/test";

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  decideTerminalBeforeKey,
  isBareEscapeKey,
  type TerminalBeforeKeyEvent,
} from "./terminalBeforeKey";

const defaultKeybindings = [
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
  {
    command: "terminal.toggle",
    shortcut: {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
  },
  {
    command: "terminal.split",
    shortcut: {
      key: "d",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    whenAst: { type: "identifier", name: "terminalFocus" },
  },
] satisfies ResolvedKeybindingsConfig;

const escapeCloseKeybindings = [
  {
    command: "terminal.close",
    shortcut: {
      key: "escape",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
    whenAst: { type: "identifier", name: "terminalFocus" },
  },
] satisfies ResolvedKeybindingsConfig;

type KeyboardEventOverrides = Partial<
  Pick<
    TerminalBeforeKeyEvent,
    "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "type"
  >
>;

function keyboardEvent(
  overrides: KeyboardEventOverrides = {},
): TerminalBeforeKeyEvent & { readonly defaultPrevented: boolean } {
  let defaultPrevented = false;
  return {
    key: "Escape",
    code: "Escape",
    type: "keydown",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };
}

describe("isBareEscapeKey", () => {
  it("matches Escape and esc with no modifiers", () => {
    expect(isBareEscapeKey(keyboardEvent())).toBe(true);
    expect(isBareEscapeKey(keyboardEvent({ key: "esc" }))).toBe(true);
  });

  it("rejects modified Escape", () => {
    expect(isBareEscapeKey(keyboardEvent({ metaKey: true }))).toBe(false);
    expect(isBareEscapeKey(keyboardEvent({ ctrlKey: true }))).toBe(false);
    expect(isBareEscapeKey(keyboardEvent({ shiftKey: true }))).toBe(false);
    expect(isBareEscapeKey(keyboardEvent({ altKey: true }))).toBe(false);
  });
});

describe("decideTerminalBeforeKey", () => {
  it("lets bare Escape reach the PTY and does not treat it as close", () => {
    const event = keyboardEvent();

    expect(decideTerminalBeforeKey(event, defaultKeybindings, "MacIntel")).toEqual({
      action: "encode",
    });
    expect(event.defaultPrevented).toBe(false);

    const remapped = keyboardEvent();
    expect(decideTerminalBeforeKey(remapped, escapeCloseKeybindings, "MacIntel")).toEqual({
      action: "encode",
    });
    expect(remapped.defaultPrevented).toBe(false);
  });

  it("still suppresses the default close shortcut", () => {
    const event = keyboardEvent({ key: "w", code: "KeyW", ctrlKey: true });

    expect(decideTerminalBeforeKey(event, defaultKeybindings, "Linux x86_64")).toEqual({
      action: "suppress",
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("still suppresses split and toggle shortcuts", () => {
    const split = keyboardEvent({ key: "d", code: "KeyD", metaKey: true });
    expect(decideTerminalBeforeKey(split, defaultKeybindings, "MacIntel")).toEqual({
      action: "suppress",
    });

    const toggle = keyboardEvent({ key: "j", code: "KeyJ", ctrlKey: true });
    expect(decideTerminalBeforeKey(toggle, defaultKeybindings, "Linux x86_64")).toEqual({
      action: "suppress",
    });
  });

  it("still sends navigation, delete, and clear shortcuts", () => {
    const wordLeft = keyboardEvent({ key: "ArrowLeft", altKey: true });
    expect(decideTerminalBeforeKey(wordLeft, defaultKeybindings, "MacIntel")).toEqual({
      action: "send",
      data: "\u001bb",
      error: "Failed to move cursor",
    });
    expect(wordLeft.defaultPrevented).toBe(true);

    const deleteToStart = keyboardEvent({ key: "Backspace", metaKey: true });
    expect(decideTerminalBeforeKey(deleteToStart, defaultKeybindings, "MacIntel")).toEqual({
      action: "send",
      data: "\u0015",
      error: "Failed to delete terminal input",
    });
    expect(deleteToStart.defaultPrevented).toBe(true);

    const clear = keyboardEvent({ key: "l", code: "KeyL", ctrlKey: true });
    expect(decideTerminalBeforeKey(clear, defaultKeybindings, "Linux x86_64")).toEqual({
      action: "send",
      data: "\u000c",
      error: "Failed to clear terminal",
    });
    expect(clear.defaultPrevented).toBe(true);
  });
});
