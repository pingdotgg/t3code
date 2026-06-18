import { describe, expect, it } from "vite-plus/test";

import {
  areShortcutModifierStatesEqual,
  shortcutModifierStateAfterKeyboardEvent,
  type ShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

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

  it("preserves the current object when modifier values do not change", () => {
    const initialState = emptyState();
    const nextState = shortcutModifierStateAfterKeyboardEvent(
      initialState,
      keyboardEventLike("keyup", { key: "Shift" }),
    );
    expect(nextState).toBe(initialState);
  });

  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });
});
