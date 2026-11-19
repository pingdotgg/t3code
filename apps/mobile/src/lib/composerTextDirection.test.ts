import { describe, expect, it } from "vite-plus/test";

import { composerLineDirections, composerUniformDirection } from "./composerTextDirection";

describe("composerLineDirections", () => {
  it.each([
    ["English only", "Run the build first", []],
    ["Arabic that opens with an English word", "Plantur، سيروم للشعر 100 مل", ["rtl"]],
    [
      "an English line under Arabic ones",
      "اكتب الدالة الجديدة\nثم اختبرها\nRun tests.",
      ["rtl", "rtl", "ltr"],
    ],
    [
      "an English error under an Arabic line",
      "اشرح لي هذا الخطأ من فضلك\nTypeError: cannot read property x of undefined",
      ["rtl", "ltr"],
    ],
    [
      "fenced code under Arabic",
      "شغّل هذا الأمر ثم أخبرني بالنتيجة\n```\nnpm install مكتبة\n```\nشكرا",
      ["rtl", "ltr", "ltr", "ltr", "rtl"],
    ],
    [
      "an info string does not close a fence",
      "مرحبا\n```\n```literal\nمرحبا\n```\nمرحبا",
      ["rtl", "ltr", "ltr", "ltr", "ltr", "rtl"],
    ],
    [
      "the paragraph breaks Foundation uses",
      "مرحبا\u2029Run tests.\r\nPlantur، سيروم للشعر 100 مل\rشكرا",
      ["rtl", "ltr", "rtl", "rtl"],
    ],
    ["lines without letters continue the one above", "مرحبا\n\n123", ["rtl", "rtl", "rtl"]],
  ])("%s", (_name, text, expected) => {
    expect(composerLineDirections(text)).toEqual(expected);
  });
});

describe("composerUniformDirection", () => {
  it.each([
    [["rtl", "", "rtl"], "rtl"],
    [["rtl", "ltr"], ""],
    [[], ""],
  ] as const)("%j -> %j", (lines, expected) => {
    expect(composerUniformDirection(lines)).toBe(expected);
  });
});
