import { describe, expect, it } from "vite-plus/test";

import { resolveHighlightLanguage } from "./highlightLanguage";

describe("resolveHighlightLanguage", () => {
  it.each([
    ["src/init.luau", "lua"],
    ["styles/page.xsl", "xml"],
    ["styles/page.xslt", "xml"],
  ])("%s highlights as %s", (path, language) => {
    expect(resolveHighlightLanguage({ path })).toBe(language);
  });
});
