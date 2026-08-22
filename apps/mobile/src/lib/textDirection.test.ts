import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownTextDirection, resolveTextDirection } from "./textDirection";

describe("resolveTextDirection", () => {
  it("resolves Hebrew and Arabic text as right-to-left", () => {
    expect(resolveTextDirection("הודעה בעברית")).toBe("rtl");
    expect(resolveTextDirection("رسالة بالعربية")).toBe("rtl");
  });

  it("resolves English and other left-to-right scripts as left-to-right", () => {
    expect(resolveTextDirection("English message")).toBe("ltr");
    expect(resolveTextDirection("日本語のメッセージ")).toBe("ltr");
  });

  it("ignores neutral prefixes before the first letter", () => {
    expect(resolveTextDirection("👋 123... שלום")).toBe("rtl");
    expect(resolveTextDirection("(123) Hello")).toBe("ltr");
  });

  it("defaults neutral-only content to left-to-right", () => {
    expect(resolveTextDirection("👋 123...")).toBe("ltr");
  });

  it("ignores inline and fenced code when resolving markdown prose", () => {
    expect(resolveMarkdownTextDirection("`npm` שלום")).toBe("rtl");
    expect(resolveMarkdownTextDirection("```sh\nnpm test\n```\n\nשלום")).toBe("rtl");
    expect(resolveMarkdownTextDirection("`שלום` English prose")).toBe("ltr");
  });
});
