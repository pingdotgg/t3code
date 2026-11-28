import {
  EVENT_CODE_SHORTCUT_KEYS,
  isMacPlatform,
  US_SHIFTED_TO_UNSHIFTED_KEYS,
} from "@t3tools/shared/keybindings";

export type UsKey = { code: string; shift: boolean };
export type UsKeyStroke = UsKey & { option: boolean };

const US_CODE_BY_KEY = new Map(
  Object.entries(EVENT_CODE_SHORTCUT_KEYS).map(([code, key]) => [key, code]),
);

// iOS takes the Option keys of the macOS US layout.
const US_OPTION_KEYS: Readonly<Record<string, string>> = {
  ç: "c",
  Ç: "C",
  œ: "q",
  Œ: "Q",
  æ: "'",
  Æ: '"',
  ß: "s",
  ø: "o",
  Ø: "O",
  å: "a",
  Å: "A",
  "€": "@",
  "£": "3",
  "§": "6",
  "°": "*",
  µ: "m",
  "«": "\\",
  "»": "|",
  "…": ";",
  "–": "-",
  // oxlint-disable-next-line t3code/no-em-dash-copy -- A typed character, not screen text.
  "—": "_",
  "“": "[",
  "”": "{",
  "‘": "]",
  "’": "}",
  "•": "8",
  "¡": "1",
  "¿": "?",
  "©": "g",
  "®": "r",
  "™": "2",
};

// Option plus these keys puts the accent on the next letter, as macOS dead keys do.
const US_ACCENT_KEYS: Readonly<Record<string, string>> = {
  "̀": "`",
  "́": "e",
  "̂": "i",
  "̃": "n",
  "̈": "u",
};

// The simulator reads keys with a US layout, so find the US key that types this character.
export function usKey(character: string): UsKey | undefined {
  const unshifted = US_SHIFTED_TO_UNSHIFTED_KEYS.get(character) ?? character.toLowerCase();
  const code = /^[a-z]$/.test(unshifted)
    ? `Key${unshifted.toUpperCase()}`
    : unshifted === " "
      ? "Space"
      : US_CODE_BY_KEY.get(unshifted);
  return code ? { code, shift: unshifted !== character } : undefined;
}

export function usKeyStrokes(character: string): UsKeyStroke[] | null {
  const plain = usKey(character);
  if (plain) return [{ ...plain, option: false }];

  const option = usKey(US_OPTION_KEYS[character] ?? "");
  if (option) return [{ ...option, option: true }];

  const [letter = "", accent = "", ...rest] = character.normalize("NFD");
  const accentKey = usKey(US_ACCENT_KEYS[accent] ?? "");
  const letterKey = usKey(letter);
  if (rest.length > 0 || !accentKey || !letterKey) return null;
  return [
    { ...accentKey, option: true },
    { ...letterKey, option: false },
  ];
}

// Windows and Linux shortcuts such as Ctrl+A use Ctrl where iOS uses Command.
export function iosModifierKeys() {
  const mac = isMacPlatform(navigator.platform);
  return [
    ["shiftKey", "ShiftLeft"],
    ["ctrlKey", mac ? "ControlLeft" : "MetaLeft"],
    ["altKey", "AltLeft"],
    ["metaKey", mac ? "MetaLeft" : "ControlLeft"],
  ] as const;
}
