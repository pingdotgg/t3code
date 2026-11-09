import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../test/render";
import {
  shortcutModifierStateAfterKeyboardEvent,
  type ShortcutModifierState,
  useShortcutModifierSelector,
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
    // Synthetic dictation paste can poison later real key events with metaKey=true.
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

function HeldControl() {
  const shown = useShortcutModifierSelector((modifiers, held) => held && modifiers.ctrlKey);
  return createElement("output", null, shown ? "shown" : "hidden");
}

describe("useShortcutModifierSelector", () => {
  it("waits for the delay again on a second hold", async () => {
    await using screen = await render(createElement(HeldControl), {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    using _timers = fakeTimers();
    const control = (type: "keydown" | "keyup") =>
      act(() => window.dispatchEvent(new KeyboardEvent(type, { key: "Control", ctrlKey: true })));

    await control("keydown");
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByRole("status")).toHaveTextContent("shown");

    await control("keyup");
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");

    await control("keydown");
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByRole("status")).toHaveTextContent("shown");
  });
});
