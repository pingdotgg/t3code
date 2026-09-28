// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  shortcutModifierStateAfterKeyboardEvent,
  useShortcutModifierState,
  type ShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

describe("useShortcutModifierState", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each(["keyup", "paste", "blur"] as const)(
    "does not render for unchanged modifiers after %s resets the state",
    async (reset) => {
      const render = vi.fn();
      function Consumer() {
        render(useShortcutModifierState());
        return null;
      }
      await act(async () => {
        root.render(createElement(Consumer));
      });
      const press = async (type: "keydown" | "keyup", key: string, shiftKey = false) => {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent(type, { key, shiftKey }));
        });
      };

      await press("keydown", "Shift", true);
      expect(render).toHaveBeenLastCalledWith({ ...emptyState(), shiftKey: true });
      if (reset === "keyup") {
        await press("keyup", "Shift");
      } else {
        await act(async () => {
          window.dispatchEvent(new Event(reset));
        });
      }
      expect(render).toHaveBeenLastCalledWith(emptyState());
      render.mockClear();

      for (const key of "typing") {
        await press("keydown", key);
        await press("keyup", key);
      }
      await act(async () => {
        window.dispatchEvent(new Event("paste"));
        window.dispatchEvent(new Event("blur"));
      });
      expect(render).not.toHaveBeenCalled();
      await press("keydown", "Shift", true);
      expect(render).toHaveBeenCalledExactlyOnceWith({ ...emptyState(), shiftKey: true });
    },
  );
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

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // A dictation paste (synthetic ⌘V) can leave the browser reporting
    // metaKey=true on later real key events. Enter to submit must not
    // re-mark ⌘ as held.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it("clears a held modifier when a non-modifier key reports it released", () => {
    const heldMeta: ShortcutModifierState = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const state = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike("keydown", { key: "a", metaKey: false }),
    );
    expect(state).toEqual(emptyState());
  });
});
