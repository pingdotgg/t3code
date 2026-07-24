import { describe, expect, it } from "vite-plus/test";

import { hasInlineSkillToken, parseInlineSkillTokens } from "./skillInlineTokens.ts";

describe("parseInlineSkillTokens", () => {
  it("recognizes sent skill references at sentence boundaries", () => {
    expect(parseInlineSkillTokens("Use $update-main? Then run $commit.")).toEqual([
      {
        name: "update-main",
        rawText: "$update-main",
        start: 4,
      },
      {
        name: "commit",
        rawText: "$commit",
        start: 27,
      },
    ]);
  });

  it("rejects code-variable continuations", () => {
    expect(parseInlineSkillTokens("echo $HOME/.codex or use PHP $value;")).toEqual([]);
    expect(hasInlineSkillToken("echo $HOME/.codex")).toBe(false);
    expect(hasInlineSkillToken("use PHP $value;")).toBe(false);
  });
});
