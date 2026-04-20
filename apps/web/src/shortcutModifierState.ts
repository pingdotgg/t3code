import { create } from "zustand";

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

const useShortcutModifierStateStore = create<{
  state: ShortcutModifierState;
  setState: (state: ShortcutModifierState) => void;
  clear: () => void;
}>((set) => ({
  state: EMPTY_SHORTCUT_MODIFIER_STATE,
  setState: (state) =>
    set((current) => (areShortcutModifierStatesEqual(current.state, state) ? current : { state })),
  clear: () =>
    set((current) =>
      areShortcutModifierStatesEqual(current.state, EMPTY_SHORTCUT_MODIFIER_STATE)
        ? current
        : { state: EMPTY_SHORTCUT_MODIFIER_STATE },
    ),
}));

export function useShortcutModifierState(): ShortcutModifierState {
  return useShortcutModifierStateStore((store) => store.state);
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

export function syncShortcutModifierStateFromKeyboardEvent(event: KeyboardEvent): void {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  if (normalizedModifierKey) {
    const currentState = useShortcutModifierStateStore.getState().state;
    useShortcutModifierStateStore.getState().setState({
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    });
    return;
  }

  useShortcutModifierStateStore.getState().setState({
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  });
}

export function setShortcutModifierState(state: ShortcutModifierState): void {
  useShortcutModifierStateStore.getState().setState(state);
}

export function clearShortcutModifierState(): void {
  useShortcutModifierStateStore.getState().clear();
}

export function readShortcutModifierState(): ShortcutModifierState {
  return useShortcutModifierStateStore.getState().state;
}
