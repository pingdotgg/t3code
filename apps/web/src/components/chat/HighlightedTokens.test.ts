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

function shape(parts: ReturnType<typeof wordsOf>) {
  return parts.map((part) =>
    typeof part === "string" ? part : part.pieces.map((piece) => piece.text).join(""),
  );
}

describe("wordsOf", () => {
  it.each([
    // Shiki splits these shell words into several tokens.
    [["echo", " ", '"', "$HOME", "/${", "PATH", "%%:*", '}"'], 'echo "$HOME/${PATH%%:*}"'],
    [["rsync", " ", "-a", " ", "--exclude", " ", "build"], "rsync -a --exclude build"],
    // A token can carry whitespace on either side or inside a string.
    [["git", " && ", "echo", " ", '"two  words"', "; "], 'git && echo "two  words"; '],
    [["  ", "indented"], "  indented"],
    [[], ""],
  ])("wraps the same words as the plain-text fallback: %j", (contents, line) => {
    expect(shape(wordsOf(tokensOf(...contents)))).toEqual(
      line.split(/(\s+)/u).filter((part) => part !== ""),
    );
  });

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
    // Shiki splits lines on \r?\n and drops the ending from the tokens.
    const lines = code.split(/\r?\n/u).map((line) => tokensOf(line));
    const rendered = keyedLines(code, lines)
      .map(({ tokens, ending }) => tokens.map((token) => token.content).join("") + ending)
      .join("");
    expect(rendered).toBe(code);
  });

  it("keys empty lines apart", () => {
    const code = "a\r\n\r\n\r\nb";
    const keys = keyedLines(
      code,
      code.split(/\r?\n/u).map((line) => tokensOf(line)),
    ).map((line) => line.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
