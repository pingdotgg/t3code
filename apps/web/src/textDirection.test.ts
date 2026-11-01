import { describe, expect, it } from "vite-plus/test";

import {
  markdownCodeParts,
  markdownPreview,
  markdownProseDirection,
  markdownWithDirection,
  textDirection,
} from "./textDirection";

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
    [
      "a fence-looking line with trailing text inside code",
      "```js\nconst x = 1;\n```not a close\nשלום שלום שלום שלום שלום שלום\n```\nDone",
      "ltr",
    ],
    ["a shorter fence inside code", "````js\n```\nשלום שלום שלום\n````\nDone", "ltr"],
    ["a different fence marker inside code", "~~~js\n```\nשלום שלום שלום\n~~~\nDone", "ltr"],
    ["code nested in a block quote", "> ```js\n> שלום שלום שלום\n> ```\nDone", "ltr"],
    ["a valid longer closing fence", "```js\nשלום שלום שלום\n````  \nDone", "ltr"],
  ])("reads %s", (_, markdown, direction) => {
    expect(markdownProseDirection(markdown)).toBe(direction);
  });

  it("leaves markdown without prose letters to its surroundings", () => {
    expect(markdownProseDirection("```\nconst a = 1;\n```")).toBeUndefined();
  });

  it("keeps unclosed fences inside their own question field", () => {
    expect(markdownProseDirection("Question\n```ts\nx", "בחר באפשרות הזאת בבקשה")).toBe("rtl");
  });
});

it("reads only the visible preview prose without losing truncated code boundaries", () => {
  const text = `שלום עולם בבקשה תבדוק עכשיו\n\`run({ items: [1, 2] })\` ${"hidden English words ".repeat(20)}`;
  const preview = markdownPreview(text, 42);
  expect(preview.direction).toBe("rtl");
  expect(preview.parts.map((part) => part.text).join("")).toBe(
    text.replace(/\s+/g, " ").slice(0, 42) + "…",
  );
  expect(preview.parts.at(-1)?.code).toBe(true);
});

it("seeds native paragraphs without changing Markdown block structure or code", () => {
  expect(markdownWithDirection("[!NOTE]", "rtl")).toBe("\u200f[!NOTE]");
  const image = "![diagram](https://example.com/a.png)";
  expect(markdownWithDirection(image, "rtl")).toBe(image);
  const rich =
    "| Name | Value |\n| --- | --- |\n| React | עברית |\n\n- [ ] React שינוי\n\n> [!NOTE]\n> React עדכון\n\n$$\nx^2\n$$\n\nReact המשך";
  expect(markdownWithDirection(rich, "rtl")).toBe(
    "| Name | Value |\n| --- | --- |\n| React | עברית |\n\n- [ ] \u200fReact שינוי\n\n> [!NOTE]\n> \u200fReact עדכון\n\n$$\nx^2\n$$\n\n\u200fReact המשך",
  );
  const markdown = "# React עדכון\n\n- React שינוי\n\n> English ציטוט\n\n```ts\nfoo()\n```";
  expect(markdownWithDirection(markdown, "rtl")).toBe(
    "# \u200fReact עדכון\n\n- \u200fReact שינוי\n\n> \u200fEnglish ציטוט\n\n```ts\nfoo()\n```",
  );
});

it("preserves literal markdown while separating code from prose", () => {
  const markdown =
    "שלום\n```js\nvalue({ items: [1, 2] });\n```not a close\nעדיין קוד\n```\nאחרי `run()`";
  const parts = markdownCodeParts(markdown);
  expect(parts.map((part) => part.text).join("")).toBe(markdown);
  expect(parts.filter((part) => part.code).map((part) => part.text)).toEqual([
    "```js\nvalue({ items: [1, 2] });\n```not a close\nעדיין קוד\n```",
    "`run()`",
  ]);
});
