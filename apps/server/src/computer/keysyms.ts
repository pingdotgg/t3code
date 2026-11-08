// X11 keysyms. KWin's fake input picks the shift level itself and maps
// keysyms missing from the user's layout, so text needs no layout knowledge.
const RETURN = 0xff0d;
const TAB = 0xff09;

export const MODIFIER_KEYSYMS = {
  ctrl: 0xffe3,
  shift: 0xffe1,
  alt: 0xffe9,
  super: 0xffeb,
} as const;

const MODIFIER_ALIASES: Record<string, keyof typeof MODIFIER_KEYSYMS> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  super: "super",
  meta: "super",
  win: "super",
  cmd: "super",
};

const NAMED_KEYSYMS: Record<string, number> = {
  return: RETURN,
  enter: RETURN,
  tab: TAB,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  page_up: 0xff55,
  pagedown: 0xff56,
  page_down: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  arrowleft: 0xff51,
  arrowup: 0xff52,
  arrowright: 0xff53,
  arrowdown: 0xff54,
  space: 0x20,
  menu: 0xff67,
  print: 0xff61,
  capslock: 0xffe5,
  plus: 0x2b,
};

const characterKeysym = (codePoint: number): number | null => {
  if (codePoint === 0x0a) return RETURN;
  if (codePoint === 0x09) return TAB;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return null;
  if (codePoint <= 0xff) return codePoint;
  return 0x01000000 | codePoint;
};

/** Keysyms to press and release one after another, or null when text holds a control character. */
export const textKeysyms = (text: string): ReadonlyArray<number> | null => {
  const keysyms: Array<number> = [];
  for (const character of text.replaceAll("\r\n", "\n")) {
    const keysym = characterKeysym(character.codePointAt(0)!);
    if (keysym === null) return null;
    keysyms.push(keysym);
  }
  return keysyms;
};

export interface KeyCombo {
  readonly modifiers: ReadonlyArray<number>;
  readonly key: number;
}

/** `ctrl+shift+t`, `alt+F4`, `Return`. Null when a part is not a key. */
export const parseKeyCombo = (keys: string): KeyCombo | null => {
  const parts = keys.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) return null;
  const keyName = parts.at(-1)!;
  const modifiers: Array<number> = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier === undefined) return null;
    const keysym = MODIFIER_KEYSYMS[modifier];
    if (!modifiers.includes(keysym)) modifiers.push(keysym);
  }
  const key = keyKeysym(keyName);
  return key === null ? null : { modifiers, key };
};

const keyKeysym = (name: string): number | null => {
  const lower = name.toLowerCase();
  const modifier = MODIFIER_ALIASES[lower];
  if (modifier !== undefined) return MODIFIER_KEYSYMS[modifier];
  const named = NAMED_KEYSYMS[lower];
  if (named !== undefined) return named;
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (functionKey) return 0xffbe + Number(functionKey[1]) - 1;
  const characters = [...name];
  if (characters.length !== 1) return null;
  // Combos name the key, not the shifted character: ctrl+T is ctrl+t.
  const keysym = characterKeysym(characters[0]!.toLowerCase().codePointAt(0)!);
  return keysym === RETURN || keysym === TAB ? null : keysym;
};
