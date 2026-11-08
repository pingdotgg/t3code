import { describe, expect, it } from "@effect/vitest";

import { MODIFIER_KEYSYMS, parseKeyCombo, textKeysyms } from "./keysyms.ts";

const { ctrl, shift, alt, super: meta } = MODIFIER_KEYSYMS;

describe("keysyms", () => {
  it.each([
    ["Hi!\n", [0x48, 0x69, 0x21, 0xff0d]],
    ["a\r\nb\t", [0x61, 0xff0d, 0x62, 0xff09]],
    ["é", [0xe9]],
    ["€😀", [0x010020ac, 0x0101f600]],
    ["\u001b", null],
    ["\u0085", null],
  ])("maps the text %j to keysyms", (text, keysyms) => {
    expect(textKeysyms(text)).toEqual(keysyms);
  });

  it.each([
    ["Return", { modifiers: [], key: 0xff0d }],
    ["ctrl+shift+T", { modifiers: [ctrl, shift], key: 0x74 }],
    ["Control + c", { modifiers: [ctrl], key: 0x63 }],
    ["alt+F4", { modifiers: [alt], key: 0xffc1 }],
    ["cmd+ctrl+ctrl+plus", { modifiers: [meta, ctrl], key: 0x2b }],
    ["super", { modifiers: [], key: meta }],
    ["ctrl+PageDown", { modifiers: [ctrl], key: 0xff56 }],
    ["ctrl+", null],
    ["hyper+a", null],
    ["ctrl+enterr", null],
    ["F25", null],
  ])("parses the combo %j", (keys, combo) => {
    expect(parseKeyCombo(keys)).toEqual(combo);
  });
});
