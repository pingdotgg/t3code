import { useEffect, useState } from "react";

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

export function areShortcutModifierStatesEqual(
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

export function useShortcutModifierState(): ShortcutModifierState {
  const [state, setState] = useState(EMPTY_SHORTCUT_MODIFIER_STATE);

  useEffect(() => {
    const onKeyboardEvent = (event: KeyboardEvent) => {
      setState((current) => shortcutModifierStateAfterKeyboardEvent(current, event));
    };
    const onPointerDown = (event: PointerEvent) => {
      setState((current) => {
        const nextState = {
          metaKey: current.metaKey && event.metaKey,
          ctrlKey: current.ctrlKey && event.ctrlKey,
          altKey: current.altKey && event.altKey,
          shiftKey: current.shiftKey && event.shiftKey,
        };

        return areShortcutModifierStatesEqual(current, nextState) ? current : nextState;
      });
    };
    const resetModifierState = () => {
      setState((current) =>
        areShortcutModifierStatesEqual(current, EMPTY_SHORTCUT_MODIFIER_STATE)
          ? current
          : EMPTY_SHORTCUT_MODIFIER_STATE,
      );
    };

    window.addEventListener("keydown", onKeyboardEvent, true);
    window.addEventListener("keyup", onKeyboardEvent, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("paste", resetModifierState, true);
    window.addEventListener("input", resetModifierState, true);
    window.addEventListener("blur", resetModifierState);
    window.addEventListener("focus", resetModifierState);
    document.addEventListener("visibilitychange", resetModifierState);
    return () => {
      window.removeEventListener("keydown", onKeyboardEvent, true);
      window.removeEventListener("keyup", onKeyboardEvent, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("paste", resetModifierState, true);
      window.removeEventListener("input", resetModifierState, true);
      window.removeEventListener("blur", resetModifierState);
      window.removeEventListener("focus", resetModifierState);
      document.removeEventListener("visibilitychange", resetModifierState);
    };
  }, []);

  return state;
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
  const isKeyDown = event.type === "keydown";
  const nextState: ShortcutModifierState = {
    metaKey: event.metaKey && (isKeyDown || currentState.metaKey),
    ctrlKey: event.ctrlKey && (isKeyDown || currentState.ctrlKey),
    altKey: event.altKey && (isKeyDown || currentState.altKey),
    shiftKey: event.shiftKey && (isKeyDown || currentState.shiftKey),
  };

  if (normalizedModifierKey) {
    nextState[normalizedModifierKey] = isKeyDown;
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
