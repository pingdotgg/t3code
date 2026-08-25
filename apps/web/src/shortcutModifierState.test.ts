import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  areShortcutModifierStatesEqual,
  shortcutModifierStateAfterKeyboardEvent,
  type ShortcutModifierState,
  useShortcutModifierState,
} from "./shortcutModifierState";
import { reactHookHarness } from "./test/reactHookHarness";

const effectCleanups = vi.hoisted(() => [] as Array<() => void>);

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("./test/reactHookHarness");

  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) effectCleanups.push(cleanup);
    },
  };
});

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

function installShortcutModifierHook() {
  const browserWindow = new EventTarget();
  const browserDocument = new EventTarget();
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", browserDocument);

  reactHookHarness.beginRender();
  useShortcutModifierState();

  return { window: browserWindow, document: browserDocument };
}

function dispatchModifierEvent(
  target: EventTarget,
  type: "keydown" | "keyup" | "pointerdown",
  init: Partial<KeyboardEvent>,
) {
  const event = new Event(type);
  Object.assign(event, {
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });
  target.dispatchEvent(event);
}

function currentModifierState() {
  reactHookHarness.beginRender();
  return reactHookHarness.useState(emptyState())[0];
}

afterEach(() => {
  for (const cleanup of effectCleanups.splice(0)) cleanup();
  reactHookHarness.reset();
  vi.unstubAllGlobals();
});

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

  it("does not activate Command when a function-key release reports a stale modifier", () => {
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keyup", {
        key: "Fn",
        metaKey: true,
      }),
    );

    expect(state).toEqual(emptyState());
  });

  it("clears a missed Command release when another modifier is pressed", () => {
    const state = shortcutModifierStateAfterKeyboardEvent(
      { ...emptyState(), metaKey: true },
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: false,
        shiftKey: false,
      }),
    );

    expect(state).toEqual({ ...emptyState(), shiftKey: true });
  });

  it.each(["blur", "focus"])("clears stuck modifiers on window %s", (eventType) => {
    const { window } = installShortcutModifierHook();
    dispatchModifierEvent(window, "keydown", { key: "Meta", metaKey: true });
    expect(currentModifierState().metaKey).toBe(true);

    window.dispatchEvent(new Event(eventType));

    expect(currentModifierState()).toEqual(emptyState());
  });

  it("clears stuck modifiers when page visibility changes", () => {
    const { window, document } = installShortcutModifierHook();
    dispatchModifierEvent(window, "keydown", { key: "Meta", metaKey: true });
    expect(currentModifierState().metaKey).toBe(true);

    document.dispatchEvent(new Event("visibilitychange"));

    expect(currentModifierState()).toEqual(emptyState());
  });

  it("clears stuck modifiers when a pointer press does not include them", () => {
    const { window } = installShortcutModifierHook();
    dispatchModifierEvent(window, "keydown", { key: "Meta", metaKey: true });
    expect(currentModifierState().metaKey).toBe(true);

    dispatchModifierEvent(window, "pointerdown", { metaKey: false });

    expect(currentModifierState()).toEqual(emptyState());
  });

  it.each(["paste", "input"])(
    "clears a synthetic Command press when dictated text triggers %s",
    (eventType) => {
      const { window } = installShortcutModifierHook();
      dispatchModifierEvent(window, "keydown", { key: "Meta", metaKey: true });
      dispatchModifierEvent(window, "keydown", { key: "v", metaKey: true });
      expect(currentModifierState().metaKey).toBe(true);

      window.dispatchEvent(new Event(eventType));
      dispatchModifierEvent(window, "keyup", { key: "v", metaKey: true });

      expect(currentModifierState()).toEqual(emptyState());
    },
  );
});
