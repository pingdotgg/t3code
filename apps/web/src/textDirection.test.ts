import { describe, expect, it } from "vite-plus/test";

import { markdownProseDirection, textDirection } from "./textDirection";

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
    [
      "tied sentences use the whole-text word majority",
      "Done. تم إصلاح المشكلة في الملف الرئيسي",
      "rtl",
    ],
    ["a tie, by its first word", "React مكتبة", "ltr"],
    ["a tie that opens in Arabic", "مكتبة React", "rtl"],
    ["Arabic around numbers and punctuation", "عدّل السطر 42، ثم شغّل الاختبارات (3)", "rtl"],
    [
      "mostly Arabic sentences beside one long English one",
      "هذا مثال على paragraph يحتوي على نص عربي و English words معًا. Arabic text should flow right-to-left while English words like JavaScript, React, and API should remain left-to-right within the same line. الأرقام 1234567890 ورموز مثل @username و #hashtag و 100$ تظهر في الاتجاه الصحيح. هذه جملة لاختبار RTL rendering في المتصفح أو المحرر.",
      "rtl",
    ],
    [
      "mostly English sentences beside one Arabic one",
      "Run the migration first. ثم شغّل الاختبارات كلها. Then deploy to staging.",
      "ltr",
    ],
    [
      "Arabic with inline abbreviations",
      "هذه جملة عربية تتحدث عن e.g. React i.e. TypeScript JavaScript",
      "rtl",
    ],
    [
      "an abbreviation at a sentence boundary",
      "This long English sentence describes the technology sector in the U.S. هذه جملة عربية. وهذه جملة عربية أخرى.",
      "rtl",
    ],
  ])("reads %s", (_, text, direction) => {
    expect(textDirection(text)).toBe(direction);
  });

  it("leaves text without letters to its surroundings", () => {
    expect(textDirection("42 — 7 ✓")).toBeUndefined();
  });
});

describe("markdownProseDirection", () => {
  it.each([
    [
      "Hebrew around a code block",
      "תתקן את זה:\n```ts\nexport function useCheckout(props: CheckoutProps) {\n  return props.items.length;\n}\n```\nותריץ שוב",
      "rtl",
    ],
    ["Hebrew around inline code", "לערוך את `apps/web/src/chat.tsx` או להשאיר `useMemo`?", "rtl"],
    ["Hebrew around double-backtick code", "תבדוק ``const a = `b c d e` + f`` עכשיו", "rtl"],
    [
      "Hebrew after a four-backtick fence",
      "````md\none two three four five six\n````\nשלום עולם, זה עובד",
      "rtl",
    ],
    [
      "Hebrew after a tilde fence",
      "~~~\nnpm run build --filter web --force\n~~~\nזה נכשל אצלי",
      "rtl",
    ],
    [
      "Hebrew before an unclosed fence",
      "שלום, הנה השגיאה:\n```\nError: cannot find module react dom client",
      "rtl",
    ],
    ["Hebrew around a URL", "ראה https://github.com/pingdotgg/t3code/pull/24050 לפני", "rtl"],
    ["English around inline code", "Should I edit `useMemo` or keep it?", "ltr"],
    ["English quoting one Hebrew word", "Please check the שלום label before the release", "ltr"],
  ])("reads %s", (_, markdown, direction) => {
    expect(markdownProseDirection(markdown)).toBe(direction);
  });

  it("leaves markdown without prose letters to its surroundings", () => {
    expect(markdownProseDirection("```\nconst a = 1;\n```")).toBeUndefined();
  });
});
