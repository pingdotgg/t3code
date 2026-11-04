import { isMacPlatform } from "@t3tools/shared/keybindings";

export const HID_CONTROL = 0xe0;
export const HID_SHIFT = 0xe1;
export const HID_OPTION = 0xe2;
export const HID_COMMAND = 0xe3;

export type UsKey = { usage: number; shift: boolean };
export type UsKeyStroke = UsKey & { option: boolean };

// The simulator reads HID keys with a US layout, so a key is found from the character the user's
// own layout typed, not from its position.
const US_KEY_ROWS = [
  {
    firstUsage: 0x04,
    plain: "abcdefghijklmnopqrstuvwxyz1234567890",
    shifted: "ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()",
  },
  { firstUsage: 0x2c, plain: " -=[]\\", shifted: " _+{}|" },
  { firstUsage: 0x33, plain: ";'`,./", shifted: ':"~<>?' },
];

const US_KEYS = new Map<string, UsKey>();
for (const { firstUsage, plain, shifted } of US_KEY_ROWS) {
  [...plain].forEach((character, index) => {
    US_KEYS.set(shifted[index]!, { usage: firstUsage + index, shift: true });
    US_KEYS.set(character, { usage: firstUsage + index, shift: false });
  });
}

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

export function usKey(character: string): UsKey | undefined {
  return US_KEYS.get(character);
}

export function usKeyStrokes(character: string): UsKeyStroke[] | null {
  const plain = US_KEYS.get(character);
  if (plain) return [{ ...plain, option: false }];

  const option = US_KEYS.get(US_OPTION_KEYS[character] ?? "");
  if (option) return [{ ...option, option: true }];

  const [letter = "", accent = "", ...rest] = character.normalize("NFD");
  const accentKey = US_KEYS.get(US_ACCENT_KEYS[accent] ?? "");
  const letterKey = US_KEYS.get(letter);
  if (rest.length > 0 || !accentKey || !letterKey) return null;
  return [
    { ...accentKey, option: true },
    { ...letterKey, option: false },
  ];
}

function isMac() {
  return isMacPlatform(globalThis.navigator?.platform ?? "");
}

export function typedCharacter(event: KeyboardEvent): string | null {
  if (event.metaKey) return null;
  const character = [...event.key].length === 1 ? event.key : null;
  if (!event.ctrlKey || event.getModifierState("AltGraph")) return character;
  // Windows reports AltGr as Ctrl+Alt. A real Ctrl+Alt shortcut reports the plain letter or digit.
  const isAltGraph = event.altKey && !isMac() && !/^[a-z0-9]$/i.test(character ?? "a");
  return isAltGraph ? character : null;
}

// Windows and Linux shortcuts such as Ctrl+A use Ctrl where iOS uses Command.
export function iosModifierKeys() {
  const mac = isMac();
  return [
    ["shiftKey", HID_SHIFT],
    ["ctrlKey", mac ? HID_CONTROL : HID_COMMAND],
    ["altKey", HID_OPTION],
    ["metaKey", mac ? HID_COMMAND : HID_CONTROL],
  ] as const;
}
