import type { PreviewAutomationPressInput } from "@t3tools/contracts";

interface KeyDefinition {
  readonly code: string;
  readonly key: string;
  readonly keyCode: number;
  readonly text?: string;
  readonly location?: number;
  readonly shiftedKey?: string;
}

export interface PreviewAutomationKeyEvent {
  readonly [key: string]: unknown;
  readonly type: "keyDown" | "rawKeyDown" | "keyUp";
  readonly key: string;
  readonly code: string;
  readonly modifiers: number;
  readonly windowsVirtualKeyCode: number;
  readonly location: number;
  readonly isKeypad: boolean;
  readonly text?: string;
  readonly unmodifiedText?: string;
  readonly commands?: ReadonlyArray<string>;
}

export interface PreviewAutomationKeySequence {
  readonly keyDown: PreviewAutomationKeyEvent;
  readonly keyUp: PreviewAutomationKeyEvent;
  readonly signal: {
    readonly kind: "key";
    readonly key: string;
    readonly code: string;
  };
}

const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
  Escape: { code: "Escape", key: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", key: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", key: "Tab", keyCode: 9 },
  Enter: { code: "Enter", key: "Enter", keyCode: 13, text: "\r" },
  Shift: { code: "ShiftLeft", key: "Shift", keyCode: 16, location: 1 },
  Control: { code: "ControlLeft", key: "Control", keyCode: 17, location: 1 },
  Alt: { code: "AltLeft", key: "Alt", keyCode: 18, location: 1 },
  Meta: { code: "MetaLeft", key: "Meta", keyCode: 91, location: 1 },
  CapsLock: { code: "CapsLock", key: "CapsLock", keyCode: 20 },
  Space: { code: "Space", key: " ", keyCode: 32, text: " " },
  PageUp: { code: "PageUp", key: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", key: "PageDown", keyCode: 34 },
  End: { code: "End", key: "End", keyCode: 35 },
  Home: { code: "Home", key: "Home", keyCode: 36 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", keyCode: 40 },
  Insert: { code: "Insert", key: "Insert", keyCode: 45 },
  Delete: { code: "Delete", key: "Delete", keyCode: 46 },
};

const PRINTABLE_KEYS: ReadonlyArray<KeyDefinition> = [
  { code: "Backquote", key: "`", shiftedKey: "~", keyCode: 192 },
  { code: "Digit1", key: "1", shiftedKey: "!", keyCode: 49 },
  { code: "Digit2", key: "2", shiftedKey: "@", keyCode: 50 },
  { code: "Digit3", key: "3", shiftedKey: "#", keyCode: 51 },
  { code: "Digit4", key: "4", shiftedKey: "$", keyCode: 52 },
  { code: "Digit5", key: "5", shiftedKey: "%", keyCode: 53 },
  { code: "Digit6", key: "6", shiftedKey: "^", keyCode: 54 },
  { code: "Digit7", key: "7", shiftedKey: "&", keyCode: 55 },
  { code: "Digit8", key: "8", shiftedKey: "*", keyCode: 56 },
  { code: "Digit9", key: "9", shiftedKey: "(", keyCode: 57 },
  { code: "Digit0", key: "0", shiftedKey: ")", keyCode: 48 },
  { code: "Minus", key: "-", shiftedKey: "_", keyCode: 189 },
  { code: "Equal", key: "=", shiftedKey: "+", keyCode: 187 },
  { code: "Backslash", key: "\\", shiftedKey: "|", keyCode: 220 },
  { code: "BracketLeft", key: "[", shiftedKey: "{", keyCode: 219 },
  { code: "BracketRight", key: "]", shiftedKey: "}", keyCode: 221 },
  { code: "Semicolon", key: ";", shiftedKey: ":", keyCode: 186 },
  { code: "Quote", key: "'", shiftedKey: '"', keyCode: 222 },
  { code: "Comma", key: ",", shiftedKey: "<", keyCode: 188 },
  { code: "Period", key: ".", shiftedKey: ">", keyCode: 190 },
  { code: "Slash", key: "/", shiftedKey: "?", keyCode: 191 },
];

/**
 * Chromium does not infer macOS editing commands from synthetic Meta chords.
 * Keep the common browser editing/navigation shortcuts explicit so dispatched
 * key events behave like their physical-key equivalents.
 */
const MAC_EDITING_COMMANDS: Readonly<Record<string, string>> = {
  "Meta+Backspace": "deleteToBeginningOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Meta+ArrowLeft": "moveToLeftEndOfLine",
  "Meta+ArrowRight": "moveToRightEndOfLine",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Meta+KeyA": "selectAll",
  "Meta+KeyC": "copy",
  "Meta+KeyX": "cut",
  "Meta+KeyV": "paste",
  "Meta+KeyZ": "undo",
  "Shift+Meta+KeyZ": "redo",
};
const SHORTCUT_MODIFIER_ORDER = ["Shift", "Control", "Alt", "Meta"] as const;

const macEditingCommands = (
  code: string,
  modifiers: PreviewAutomationPressInput["modifiers"],
): ReadonlyArray<string> => {
  const shortcut = [
    ...SHORTCUT_MODIFIER_ORDER.filter((modifier) => modifiers?.includes(modifier)),
    code,
  ].join("+");
  const command = MAC_EDITING_COMMANDS[shortcut];
  return command ? [command] : [];
};

const modifierMask = (modifiers: PreviewAutomationPressInput["modifiers"]): number =>
  (modifiers ?? []).reduce((value, modifier) => {
    switch (modifier) {
      case "Alt":
        return value | 1;
      case "Control":
        return value | 2;
      case "Meta":
        return value | 4;
      case "Shift":
        return value | 8;
    }
  }, 0);

function resolveKeyDefinition(input: PreviewAutomationPressInput): KeyDefinition {
  const named = NAMED_KEYS[input.key];
  if (named) return named;

  const functionKey = /^F([1-9]|1[0-2])$/.exec(input.key);
  if (functionKey) {
    const number = Number(functionKey[1]);
    return { code: input.key, key: input.key, keyCode: 111 + number };
  }

  if (/^[a-z]$/i.test(input.key)) {
    const upper = input.key.toUpperCase();
    const shifted = input.modifiers?.includes("Shift") ?? false;
    const key = shifted || input.key === upper ? upper : input.key;
    return { code: `Key${upper}`, key, keyCode: upper.charCodeAt(0), text: key };
  }

  const printable = PRINTABLE_KEYS.find(
    (definition) => definition.key === input.key || definition.shiftedKey === input.key,
  );
  if (printable) {
    const shifted = input.modifiers?.includes("Shift") ?? false;
    const key =
      printable.shiftedKey && (shifted || input.key === printable.shiftedKey)
        ? printable.shiftedKey
        : printable.key;
    return { ...printable, key, text: key };
  }

  return {
    code: input.key.length > 1 ? input.key : "",
    key: input.key,
    keyCode: 0,
    ...(input.key.length === 1 ? { text: input.key } : {}),
  };
}

/**
 * Build Chromium CDP key packets using the same required fields and down-event
 * choice as Playwright's pinned Chromium keyboard implementation.
 */
export function makePreviewAutomationKeySequence(
  input: PreviewAutomationPressInput,
  options?: { readonly isMac?: boolean },
): PreviewAutomationKeySequence {
  const definition = resolveKeyDefinition(input);
  const modifiers = modifierMask(input.modifiers);
  const suppressText = input.modifiers?.some((modifier) => modifier !== "Shift") ?? false;
  const text = suppressText ? "" : (definition.text ?? "");
  const location = definition.location ?? 0;
  const commands = options?.isMac ? macEditingCommands(definition.code, input.modifiers) : [];
  const shared = {
    key: definition.key,
    code: definition.code,
    modifiers,
    windowsVirtualKeyCode: definition.keyCode,
    location,
    isKeypad: location === 3,
  };

  return {
    keyDown: {
      type: text ? "keyDown" : "rawKeyDown",
      ...shared,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(commands.length > 0 ? { commands } : {}),
    },
    keyUp: { type: "keyUp", ...shared },
    signal: { kind: "key", key: definition.key, code: definition.code },
  };
}
