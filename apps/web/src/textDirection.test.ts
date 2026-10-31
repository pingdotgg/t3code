import { describe, expect, it } from "vite-plus/test";

import { textDirection } from "./textDirection";

describe("textDirection", () => {
  it.each([
    ["Arabic", "اكتب دالة تجمع الأرقام", "rtl"],
    ["Hebrew", "תקן את הבאג", "rtl"],
    ["English", "fix the failing test", "ltr"],
    [
      "Arabic that opens with an English term",
      "StrictMode: يعيد الـ render مرتين في التطوير",
      "rtl",
    ],
    ["English quoting one Arabic word", "translate the label مرحبا for the login screen", "ltr"],
    ["a tie, by its first word", "React مكتبة", "ltr"],
    ["a tie that opens in Arabic", "مكتبة React", "rtl"],
    ["Arabic around numbers and punctuation", "عدّل السطر 42، ثم شغّل الاختبارات (3)", "rtl"],
  ])("reads %s", (_, text, direction) => {
    expect(textDirection(text)).toBe(direction);
  });

  it("leaves text without letters to its surroundings", () => {
    expect(textDirection("42 — 7 ✓")).toBeUndefined();
  });
});
