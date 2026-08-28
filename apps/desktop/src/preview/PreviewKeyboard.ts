import type { PreviewAutomationPressInput } from "@t3tools/contracts";
import type { KeyboardInputEvent } from "electron";

interface KeyDefinition {
  readonly code: string;
  readonly key: string;
  readonly nativeKeyCode: string;
  readonly text?: string;
  readonly shiftedKey?: string;
}

interface PreviewAutomationKeySignal {
  readonly kind: "key";
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly control: boolean;
  readonly alt: boolean;
}

export interface PreviewAutomationKeySequence {
  readonly keyDown: KeyboardInputEvent;
  readonly char?: KeyboardInputEvent;
  readonly keyUp: KeyboardInputEvent;
  readonly keyDownSignal: PreviewAutomationKeySignal;
  readonly keyUpSignal: PreviewAutomationKeySignal;
}

type PreviewAutomationModifier = "alt" | "control" | "meta" | "shift";

const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
  Escape: { code: "Escape", key: "Escape", nativeKeyCode: "Escape" },
  Backspace: { code: "Backspace", key: "Backspace", nativeKeyCode: "Backspace" },
  Tab: { code: "Tab", key: "Tab", nativeKeyCode: "Tab" },
  Enter: { code: "Enter", key: "Enter", nativeKeyCode: "Enter", text: "\r" },
  Shift: { code: "ShiftLeft", key: "Shift", nativeKeyCode: "Shift" },
  Control: { code: "ControlLeft", key: "Control", nativeKeyCode: "Control" },
  Alt: { code: "AltLeft", key: "Alt", nativeKeyCode: "Alt" },
  Meta: { code: "MetaLeft", key: "Meta", nativeKeyCode: "Meta" },
  CapsLock: { code: "CapsLock", key: "CapsLock", nativeKeyCode: "CapsLock" },
  Space: { code: "Space", key: " ", nativeKeyCode: "Space", text: " " },
  PageUp: { code: "PageUp", key: "PageUp", nativeKeyCode: "PageUp" },
  PageDown: { code: "PageDown", key: "PageDown", nativeKeyCode: "PageDown" },
  End: { code: "End", key: "End", nativeKeyCode: "End" },
  Home: { code: "Home", key: "Home", nativeKeyCode: "Home" },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", nativeKeyCode: "Left" },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", nativeKeyCode: "Up" },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", nativeKeyCode: "Right" },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", nativeKeyCode: "Down" },
  Insert: { code: "Insert", key: "Insert", nativeKeyCode: "Insert" },
  Delete: { code: "Delete", key: "Delete", nativeKeyCode: "Delete" },
};

const PRINTABLE_KEYS: ReadonlyArray<KeyDefinition> = [
  { code: "Backquote", key: "`", shiftedKey: "~", nativeKeyCode: "`" },
  { code: "Digit1", key: "1", shiftedKey: "!", nativeKeyCode: "1" },
  { code: "Digit2", key: "2", shiftedKey: "@", nativeKeyCode: "2" },
  { code: "Digit3", key: "3", shiftedKey: "#", nativeKeyCode: "3" },
  { code: "Digit4", key: "4", shiftedKey: "$", nativeKeyCode: "4" },
  { code: "Digit5", key: "5", shiftedKey: "%", nativeKeyCode: "5" },
  { code: "Digit6", key: "6", shiftedKey: "^", nativeKeyCode: "6" },
  { code: "Digit7", key: "7", shiftedKey: "&", nativeKeyCode: "7" },
  { code: "Digit8", key: "8", shiftedKey: "*", nativeKeyCode: "8" },
  { code: "Digit9", key: "9", shiftedKey: "(", nativeKeyCode: "9" },
  { code: "Digit0", key: "0", shiftedKey: ")", nativeKeyCode: "0" },
  { code: "Minus", key: "-", shiftedKey: "_", nativeKeyCode: "-" },
  { code: "Equal", key: "=", shiftedKey: "+", nativeKeyCode: "=" },
  { code: "Backslash", key: "\\", shiftedKey: "|", nativeKeyCode: "\\" },
  { code: "BracketLeft", key: "[", shiftedKey: "{", nativeKeyCode: "[" },
  { code: "BracketRight", key: "]", shiftedKey: "}", nativeKeyCode: "]" },
  { code: "Semicolon", key: ";", shiftedKey: ":", nativeKeyCode: ";" },
  { code: "Quote", key: "'", shiftedKey: '"', nativeKeyCode: "'" },
  { code: "Comma", key: ",", shiftedKey: "<", nativeKeyCode: "," },
  { code: "Period", key: ".", shiftedKey: ">", nativeKeyCode: "." },
  { code: "Slash", key: "/", shiftedKey: "?", nativeKeyCode: "/" },
];

const MODIFIER_FOR_KEY: Readonly<Record<string, PreviewAutomationModifier | undefined>> = {
  Alt: "alt",
  Control: "control",
  Meta: "meta",
  Shift: "shift",
};

const makeSignal = (
  definition: KeyDefinition,
  modifiers: ReadonlyArray<PreviewAutomationModifier>,
): PreviewAutomationKeySignal => ({
  kind: "key",
  key: definition.key,
  code: definition.code,
  meta: modifiers.includes("meta"),
  shift: modifiers.includes("shift"),
  control: modifiers.includes("control"),
  alt: modifiers.includes("alt"),
});

function resolveKeyDefinition(input: PreviewAutomationPressInput): KeyDefinition {
  const named = NAMED_KEYS[input.key];
  if (named) return named;

  const functionKey = /^F([1-9]|1[0-2])$/.exec(input.key);
  if (functionKey) {
    return { code: input.key, key: input.key, nativeKeyCode: input.key };
  }

  if (/^[a-z]$/i.test(input.key)) {
    const upper = input.key.toUpperCase();
    const shifted = input.modifiers?.includes("Shift") ?? false;
    const key = shifted || input.key === upper ? upper : input.key;
    return { code: `Key${upper}`, key, nativeKeyCode: upper, text: key };
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

  throw new Error(
    `Unsupported preview automation key ${JSON.stringify(input.key)}. Use preview_type for Unicode text.`,
  );
}

/**
 * Build Electron native key packets. `keyDown` is separate from `char`: the
 * former emits keyboard events, while the latter inserts printable text.
 */
export function makePreviewAutomationKeySequence(
  input: PreviewAutomationPressInput,
): PreviewAutomationKeySequence {
  const definition = resolveKeyDefinition(input);
  const explicitModifiers = Array.from(
    new Set((input.modifiers ?? []).map((modifier) => modifier.toLowerCase())),
  ) as Array<PreviewAutomationModifier>;
  const needsImplicitShift =
    /^[A-Z]$/.test(definition.key) || definition.shiftedKey === definition.key;
  if (needsImplicitShift && !explicitModifiers.includes("shift")) explicitModifiers.push("shift");
  const pressedModifier = MODIFIER_FOR_KEY[definition.key];
  const keyDownModifiers = [...explicitModifiers];
  if (pressedModifier && !keyDownModifiers.includes(pressedModifier)) {
    keyDownModifiers.push(pressedModifier);
  }
  const keyUpModifiers = pressedModifier
    ? explicitModifiers.filter((modifier) => modifier !== pressedModifier)
    : [...explicitModifiers];
  const suppressText = input.modifiers?.some((modifier) => modifier !== "Shift") ?? false;

  return {
    keyDown: {
      type: "rawKeyDown",
      keyCode: definition.nativeKeyCode,
      modifiers: keyDownModifiers,
    },
    ...(!suppressText && definition.text
      ? {
          char: {
            type: "char" as const,
            keyCode: definition.text,
            modifiers: keyDownModifiers,
          },
        }
      : {}),
    keyUp: {
      type: "keyUp",
      keyCode: definition.nativeKeyCode,
      modifiers: keyUpModifiers,
    },
    keyDownSignal: makeSignal(definition, keyDownModifiers),
    keyUpSignal: makeSignal(definition, keyUpModifiers),
  };
}
