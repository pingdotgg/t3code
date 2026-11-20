import { describe, expect, it } from "vite-plus/test";

import { extractFenceLanguage, extractFenceTitle } from "./fences";

describe("a fenced block's info string", () => {
  it("Given a class with a language, when the language is read, then the highlighter's name comes back", () => {
    expect(extractFenceLanguage("language-typescript")).toBe("typescript");
    expect(extractFenceLanguage("language-gitignore")).toBe("ini");
  });

  it("Given no language class, when the language is read, then it is plain text", () => {
    expect(extractFenceLanguage(undefined)).toBe("text");
  });

  it("Given a title attribute or a bare file name, when the title is read, then the file name comes back", () => {
    expect(extractFenceTitle('title="src/a.ts" {1}')).toBe("src/a.ts");
    expect(extractFenceTitle("src/b.ts")).toBe("src/b.ts");
    expect(extractFenceTitle("{1,3}")).toBeNull();
  });
});
