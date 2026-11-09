import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isEditableFocused } from "./lib/editableFocus";

export interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

export function useShortcutModifierState(ignoreEditable = false): ShortcutModifierState {
  const [state, setState] = useState(EMPTY_SHORTCUT_MODIFIER_STATE);
  const stateRef = useRef(EMPTY_SHORTCUT_MODIFIER_STATE);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window key, focus, paste and blur listeners that track held shortcut modifiers
  useEffect(() => {
    const updateState = (next: ShortcutModifierState) => {
      if (areShortcutModifierStatesEqual(stateRef.current, next)) return;
      stateRef.current = next;
      setState(next);
    };
    const onKeyboardEvent = (event: KeyboardEvent) => {
      updateState(
        ignoreEditable && isEditableFocused(event.target)
          ? EMPTY_SHORTCUT_MODIFIER_STATE
          : shortcutModifierStateAfterKeyboardEvent(stateRef.current, event),
      );
    };
    // Dictation tools can omit Meta keyup after synthetic paste, leaving jump hints stuck.
    const onResetEvent = () => {
      updateState(EMPTY_SHORTCUT_MODIFIER_STATE);
    };

    const onFocus = (event: FocusEvent) => {
      if (ignoreEditable && isEditableFocused(event.target)) onResetEvent();
    };
    window.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKeyboardEvent, true);
    window.addEventListener("keyup", onKeyboardEvent, true);
    window.addEventListener("paste", onResetEvent, true);
    window.addEventListener("blur", onResetEvent);
    return () => {
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKeyboardEvent, true);
      window.removeEventListener("keyup", onKeyboardEvent, true);
      window.removeEventListener("paste", onResetEvent, true);
      window.removeEventListener("blur", onResetEvent);
    };
  }, [ignoreEditable]);

  return state;
}

// Modifiers count as held once unchanged this long, so a quick chord never shows hints.
const MODIFIERS_HELD_AFTER_MS = 200;

let sharedModifiers = EMPTY_SHORTCUT_MODIFIER_STATE;
let sharedModifiersHeld = false;
let heldTimer: ReturnType<typeof setTimeout> | undefined;
const modifierListeners = new Set<() => void>();

function notifyModifierListeners(): void {
  for (const listener of modifierListeners) listener();
}

function setSharedModifiers(next: ShortcutModifierState): void {
  if (areShortcutModifierStatesEqual(sharedModifiers, next)) return;
  sharedModifiers = next;
  sharedModifiersHeld = false;
  clearTimeout(heldTimer);
  if (!areShortcutModifierStatesEqual(next, EMPTY_SHORTCUT_MODIFIER_STATE)) {
    heldTimer = setTimeout(() => {
      sharedModifiersHeld = true;
      notifyModifierListeners();
    }, MODIFIERS_HELD_AFTER_MS);
  }
  notifyModifierListeners();
}

const onSharedKeyboardEvent = (event: KeyboardEvent) =>
  setSharedModifiers(shortcutModifierStateAfterKeyboardEvent(sharedModifiers, event));
// Dictation tools can omit Meta keyup after synthetic paste, leaving jump hints stuck.
const onSharedResetEvent = () => setSharedModifiers(EMPTY_SHORTCUT_MODIFIER_STATE);

function subscribeToModifiers(listener: () => void): () => void {
  if (modifierListeners.size === 0) {
    window.addEventListener("keydown", onSharedKeyboardEvent, true);
    window.addEventListener("keyup", onSharedKeyboardEvent, true);
    window.addEventListener("paste", onSharedResetEvent, true);
    window.addEventListener("blur", onSharedResetEvent);
  }
  modifierListeners.add(listener);
  return () => {
    modifierListeners.delete(listener);
    if (modifierListeners.size > 0) return;
    window.removeEventListener("keydown", onSharedKeyboardEvent, true);
    window.removeEventListener("keyup", onSharedKeyboardEvent, true);
    window.removeEventListener("paste", onSharedResetEvent, true);
    window.removeEventListener("blur", onSharedResetEvent);
    clearTimeout(heldTimer);
    sharedModifiers = EMPTY_SHORTCUT_MODIFIER_STATE;
    sharedModifiersHeld = false;
  };
}

/**
 * A primitive derived from the pressed modifiers, re-rendering only when it changes.
 * `held` turns true once the modifiers have stayed unchanged for a moment.
 */
export function useShortcutModifierSelector<T extends string | number | boolean | null>(
  select: (modifiers: ShortcutModifierState, held: boolean) => T,
): T {
  return useSyncExternalStore(subscribeToModifiers, () =>
    select(sharedModifiers, sharedModifiersHeld),
  );
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  let nextState: ShortcutModifierState;
  if (normalizedModifierKey) {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    };
  } else {
    // Dictation paste can poison real events with metaKey=true until a physical Meta press.
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    };
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
