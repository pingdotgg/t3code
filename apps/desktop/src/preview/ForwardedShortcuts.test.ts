import { assert, describe, it } from "vite-plus/test";

import { forwardedShortcutEvent } from "./ForwardedShortcuts.ts";

const focusUrl = { key: "l", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
const devTools = { key: "i", metaKey: false, ctrlKey: true, shiftKey: false, altKey: true };

const input = (overrides: Partial<Parameters<typeof forwardedShortcutEvent>[0]>) => ({
  type: "keyDown",
  key: "l",
  code: "KeyL",
  meta: false,
  control: false,
  shift: false,
  alt: false,
  isAutoRepeat: false,
  ...overrides,
});

describe("forwardedShortcutEvent", () => {
  it("claims forwarded chords with exactly their modifiers", () => {
    assert.deepStrictEqual(forwardedShortcutEvent(input({ meta: true }), [focusUrl], "darwin"), {
      key: "l",
      code: "KeyL",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
    });
    assert.isNull(forwardedShortcutEvent(input({ meta: true, shift: true }), [focusUrl], "darwin"));
    assert.isNull(
      forwardedShortcutEvent(input({ meta: true, type: "keyUp" }), [focusUrl], "darwin"),
    );
  });

  it("leaves AltGr symbols on Windows with the page", () => {
    const altGr = { key: "¡", code: "KeyI", control: true, alt: true };
    assert.isNull(forwardedShortcutEvent(input(altGr), [devTools], "win32"));
    assert.isNotNull(forwardedShortcutEvent(input({ ...altGr, key: "i" }), [devTools], "win32"));
  });
});
