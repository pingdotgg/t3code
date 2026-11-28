import { describe, expect, it } from "vite-plus/test";

import { noteSlugFromTitle } from "./botFiles.ts";

describe("noteSlugFromTitle", () => {
  it.each([
    ["Deploy checklist", [], "deploy-checklist"],
    ["  Who owns *CI*?  ", [], "who-owns-ci"],
    ["日本語", [], "note"],
    ["Release", ["release", "release-2"], "release-3"],
    ["a".repeat(70), ["a".repeat(64)], `${"a".repeat(62)}-2`],
  ])("%j with %j taken -> %s", (title, taken, expected) => {
    expect(noteSlugFromTitle(title, new Set(taken))).toBe(expected);
  });
});
