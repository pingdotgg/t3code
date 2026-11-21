import { describe, expect, it } from "vite-plus/test";

import {
  composerParagraphDirections,
  fieldDirection,
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
  for (const image of [
    "![diagram](https://example.com/a.png)",
    "[![diagram](https://example.com/a.png)](https://example.com)",
    "![diagram][image]\n\n[image]: https://example.com/a.png",
  ]) {
    expect(markdownWithDirection(image, "rtl")).toBe(image);
  }
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

it.each([
  ["an English label in a Hebrew set", "GitHub token", "rtl", "ltr"],
  [
    "a mostly English label with a Hebrew word in a Hebrew set",
    "Squash ל-feature branch",
    "rtl",
    "rtl",
  ],
  [
    "a mostly English label with a Hebrew word in an English set",
    "Squash ל-feature branch",
    "ltr",
    "ltr",
  ],
] as const)("fieldDirection reads %s", (_, text, setDirection, direction) => {
  expect(fieldDirection(text, setDirection)).toBe(direction);
});

describe("composerParagraphDirections", () => {
  const directions = (text: string) =>
    composerParagraphDirections(text).map((paragraph) => paragraph.direction);

  it("uses the desktop word majority and first-word tie break per paragraph", () => {
    expect(
      directions("React עדכון הקוד בעברית\nEnglish stays left.\nשלום React\nReact שלום"),
    ).toEqual(["rtl", "ltr", "rtl", "ltr"]);
  });

  it("inherits prose direction across empty and numeric paragraphs, without inheriting code", () => {
    expect(directions("اكتب الدالة\n\n42\n```\n// احسب مجموع القيم هنا\n```\n\nfix it\n")).toEqual([
      "rtl",
      "rtl",
      "rtl",
      "ltr",
      "ltr",
      "ltr",
      "rtl",
      "ltr",
      "ltr",
    ]);
  });

  it("excludes inline code and native chips from the word count", () => {
    expect(directions("`useEffect` ו `useLayoutEffect` בעברית `React`")).toEqual(["rtl"]);
    const chip = "@long-english-file-name ";
    expect(composerParagraphDirections(chip + "שלום", [{ start: 0, end: chip.length }])).toEqual([
      { start: 0, end: chip.length + 4, direction: "rtl" },
    ]);
  });

  it("keeps a list or quote in one direction, as the desktop composer does", () => {
    expect(directions("- Vitest\n- اختبر الدالة الجديدة\n- وأضف تعليق")).toEqual([
      "rtl",
      "rtl",
      "rtl",
    ]);
    expect(directions("> React\n> עדכון הקוד בעברית")).toEqual(["rtl", "rtl"]);
  });

  it("uses native UTF-16 offsets and includes the trailing empty paragraph", () => {
    const urlDraft = "https://github.com/foo/bar שלום\nEnglish https://example.com\n";
    expect(composerParagraphDirections(urlDraft)).toEqual([
      { start: 0, end: urlDraft.indexOf("\n") + 1, direction: "rtl" },
      { start: urlDraft.indexOf("\n") + 1, end: urlDraft.length, direction: "ltr" },
      { start: urlDraft.length, end: urlDraft.length, direction: "ltr" },
    ]);
    expect(composerParagraphDirections("😀 שלום\r\nEnglish\n")).toEqual([
      { start: 0, end: 9, direction: "rtl" },
      { start: 9, end: 17, direction: "ltr" },
      { start: 17, end: 17, direction: "ltr" },
    ]);
  });
});
