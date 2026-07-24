import { describe, expect, it } from "vite-plus/test";
import { containsRtl, dirFor, dirForMarkdown, isRtlText } from "./rtl";

describe("isRtlText", () => {
  const cases: Array<[string, boolean]> = [
    ["שלום עולם", true],
    ["مرحبا بالعالم", true],
    ["سلام دنیا", true],
    ["שלום hello עולם", true],
    ["Note: بقية الجملة عربية طويلة جدا", true],
    ["Hello world", false],
    ["Hello world שלום", false],
    ["", false],
    ["12345 !@#$%", false],
    ["ﭐﭑﭒ ﬠﬡ", true],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(isRtlText(input)).toBe(expected);
    });
  }
});

describe("containsRtl", () => {
  it("detects RTL without classifying unrelated scripts as RTL", () => {
    expect(containsRtl("hello שלום")).toBe(true);
    expect(containsRtl("hello world")).toBe(false);
    expect(containsRtl("")).toBe(false);
    expect(containsRtl("中文")).toBe(false);
    expect(containsRtl("あいう")).toBe(false);
  });
});

describe("dirFor", () => {
  it("returns rtl for RTL-majority text", () => {
    expect(dirFor("שלום")).toBe("rtl");
  });

  it("returns ltr for LTR text", () => {
    expect(dirFor("hi")).toBe("ltr");
  });
});

describe("dirForMarkdown", () => {
  it("ignores markdown code when deciding direction", () => {
    expect(dirForMarkdown("- **`apps/web`**: אפליקציית React שמציגה צ'אט")).toBe("rtl");
  });
});
