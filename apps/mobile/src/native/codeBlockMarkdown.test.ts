import { describe, expect, it } from "vite-plus/test";

import { codeFenceRenderer, fencedCodeMarkdown } from "./codeBlockMarkdown";

describe("fencedCodeMarkdown", () => {
  it.each([
    ["a plain fence", "fun main() {}", "kotlin", "```kotlin\nfun main() {}\n```"],
    ["a longer fence than the code's", "```\nx\n```", "md", "````md\n```\nx\n```\n````"],
    ["no language", "x", "", "```\nx\n```"],
  ])("writes %s", (_, code, language, expected) => {
    expect(fencedCodeMarkdown(code, language)).toBe(expected);
  });
});

describe("codeFenceRenderer", () => {
  it.each([
    ["mermaid", true, { kind: "mermaid" }],
    ["math", true, { kind: "math" }],
    ["math", false, { kind: "native" }],
    ["kotlin", true, { kind: "highlight", language: "kotlin" }],
    ["KOTLIN", true, { kind: "highlight", language: "kotlin" }],
    ["diff", true, { kind: "highlight", language: "diff" }],
    ["ts", true, { kind: "native" }],
    ["python", true, { kind: "native" }],
    ["", true, { kind: "native" }],
    ["text", true, { kind: "native" }],
  ])("draws %j with math rendering %s as %j", (fence, mathRenderingEnabled, expected) => {
    expect(codeFenceRenderer(fence, mathRenderingEnabled)).toEqual(expected);
  });
});
