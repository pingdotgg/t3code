import { describe, expect, it } from "vite-plus/test";

import { fencedCodeMarkdown } from "./codeBlockMarkdown";

describe("fencedCodeMarkdown", () => {
  it.each([
    ["a plain fence", "fun main() {}", "kotlin", "```kotlin\nfun main() {}\n```"],
    ["a longer fence than the code's", "```\nx\n```", "md", "````md\n```\nx\n```\n````"],
    ["no language", "x", "", "```\nx\n```"],
  ])("writes %s", (_, code, language, expected) => {
    expect(fencedCodeMarkdown(code, language)).toBe(expected);
  });
});
