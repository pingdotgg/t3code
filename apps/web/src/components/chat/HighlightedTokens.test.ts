import { describe, expect, it } from "vite-plus/test";

import { wordsOf } from "./HighlightedTokens";

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
