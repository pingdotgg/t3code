import { describe, expect, it } from "vite-plus/test";
import { composerParagraphDirections } from "@t3tools/shared/textDirection";

function directions(text: string) {
  return composerParagraphDirections(text).map((paragraph) => paragraph.direction);
}

describe("composerParagraphDirections", () => {
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
