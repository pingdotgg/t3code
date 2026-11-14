import { describe, expect, it } from "vite-plus/test";

import { keyedLines, wordsOf } from "./HighlightedTokens";

function tokensOf(...contents: string[]) {
  let offset = 0;
  return contents.map((content) => {
    const token = { content, offset };
    offset += content.length;
    return token;
  });
}

describe("wordsOf", () => {
  it("keeps each piece's own token so colors survive regrouping", () => {
    const [word] = wordsOf(tokensOf('"', "$HOME", '"'));
    expect(
      typeof word === "string" ? null : word?.pieces.map((piece) => piece.token.content),
    ).toEqual(['"', "$HOME", '"']);
  });
});

describe("keyedLines", () => {
  it.each([
    "git status\ngit diff",
    "Get-ChildItem\r\nWrite-Output done\r\n",
    "mixed\r\nendings\n\nlone \r stays",
  ])("renders the same text as the source: %j", (code) => {
    const lines = code.split(/\r?\n/u).map((line) => tokensOf(line));
    const rendered = keyedLines(code, lines)
      .map(({ tokens, ending }) => tokens.map((token) => token.content).join("") + ending)
      .join("");
    expect(rendered).toBe(code);
  });
});
