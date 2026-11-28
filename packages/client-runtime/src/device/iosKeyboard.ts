export interface UsKeyStroke {
  readonly code: string;
  readonly shift: boolean;
  readonly option: boolean;
}

// Each US key's plain and shifted character.
const US_KEYS: Readonly<Record<string, string>> = {
  Digit1: "1!",
  Digit2: "2@",
  Digit3: "3#",
  Digit4: "4$",
  Digit5: "5%",
  Digit6: "6^",
  Digit7: "7&",
  Digit8: "8*",
  Digit9: "9(",
  Digit0: "0)",
  Minus: "-_",
  Equal: "=+",
  BracketLeft: "[{",
  BracketRight: "]}",
  Backslash: "\\|",
  Semicolon: ";:",
  Quote: "'\"",
  Backquote: "`~",
  Comma: ",<",
  Period: ".>",
  Slash: "/?",
};

const US_KEY_BY_CHARACTER = new Map<string, Omit<UsKeyStroke, "option">>();
for (const [code, [plain, shifted]] of Object.entries(US_KEYS)) {
  if (plain) US_KEY_BY_CHARACTER.set(plain, { code, shift: false });
  if (shifted) US_KEY_BY_CHARACTER.set(shifted, { code, shift: true });
}
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  const code = `Key${letter.toUpperCase()}`;
  US_KEY_BY_CHARACTER.set(letter, { code, shift: false });
  US_KEY_BY_CHARACTER.set(letter.toUpperCase(), { code, shift: true });
}

// The iOS US hardware layout has the Option characters of the macOS US layout.
const US_OPTION_CHARACTERS: Readonly<Record<string, string>> = {
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

// Option plus the key puts the accent on the next letter, for the letters listed.
const US_DEAD_KEYS: Readonly<Record<string, readonly [key: string, letters: string]>> = {
  "\u0300": ["`", "aeiou"],
  "\u0301": ["e", "aeiou"],
  "\u0302": ["i", "aeiou"],
  "\u0303": ["n", "ano"],
  "\u0308": ["u", "aeiouy"],
};

export function usKey(character: string): Omit<UsKeyStroke, "option"> | undefined {
  return US_KEY_BY_CHARACTER.get(character);
}

/** The US-layout keys that type `character` on iOS, or null when the layout has none. */
export function usKeyStrokes(character: string): ReadonlyArray<UsKeyStroke> | null {
  const plain = usKey(character);
  if (plain) return [{ ...plain, option: false }];

  const option = usKey(US_OPTION_CHARACTERS[character] ?? "");
  if (option) return [{ ...option, option: true }];

  const [letter = "", accent = "", ...rest] = character.normalize("NFD");
  const [deadKey, letters] = US_DEAD_KEYS[accent] ?? [];
  const accentKey = usKey(deadKey ?? "");
  const letterKey = usKey(letter);
  if (rest.length > 0 || !accentKey || !letterKey || !letters?.includes(letter.toLowerCase()))
    return null;
  return [
    { ...accentKey, option: true },
    { ...letterKey, option: false },
  ];
}
