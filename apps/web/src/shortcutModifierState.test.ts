import { describe, expect, it } from "vitest";

import {
  areShortcutModifierStatesEqual,
  clearShortcutModifierState,
  readShortcutModifierState,
  setShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "./shortcutModifierState";

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("compares modifier states by value", () => {
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      ),
    ).toBe(true);
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true },
      ),
    ).toBe(false);
  });

  it("preserves the current store object when modifier values do not change", () => {
    clearShortcutModifierState();

    const initialState = readShortcutModifierState();
    setShortcutModifierState({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    expect(readShortcutModifierState()).toBe(initialState);

    setShortcutModifierState({
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    });
    const updatedState = readShortcutModifierState();
    expect(updatedState).not.toBe(initialState);
    expect(updatedState).toEqual({
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    });

    setShortcutModifierState({
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    });
    expect(readShortcutModifierState()).toBe(updatedState);

    clearShortcutModifierState();
    const clearedState = readShortcutModifierState();
    expect(clearedState).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    expect(clearedState).not.toBe(updatedState);

    clearShortcutModifierState();
    expect(readShortcutModifierState()).toBe(clearedState);
  });

  it("tracks bare modifier keydown and keyup events explicitly", () => {
    clearShortcutModifierState();

    syncShortcutModifierStateFromKeyboardEvent(
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(readShortcutModifierState()).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    syncShortcutModifierStateFromKeyboardEvent(
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(readShortcutModifierState()).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    syncShortcutModifierStateFromKeyboardEvent(
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(readShortcutModifierState()).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    syncShortcutModifierStateFromKeyboardEvent(
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(readShortcutModifierState()).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });
});
