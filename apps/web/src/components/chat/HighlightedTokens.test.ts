import { describe, expect, it } from "vite-plus/test";

import { embeddedScripts } from "../../lib/embeddedScripts";
import { keyedLines, withEmbeddedScripts, wordsOf } from "./HighlightedTokens";

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

describe("withEmbeddedScripts", () => {
  // A stand-in grammar: each word is one token colored with the language name,
  // and lines split the way Shiki splits them.
  function tokenize(text: string, language: string) {
    if (language === "unknown") throw new Error("Language not found");
    let lineStart = 0;
    return text.split(/\r?\n/u).map((line) => {
      const tokens = [...line.matchAll(/\S+|\s+/gu)].map((match) => ({
        content: match[0],
        offset: lineStart + match.index,
        color: language,
      }));
      lineStart +=
        line.length + (text.slice(lineStart + line.length).match(/^\r?\n/u)?.[0].length ?? 0);
      return tokens;
    });
  }

  function colorsOf(code: string, scripts = embeddedScripts(code)) {
    const lines = withEmbeddedScripts(code, tokenize(code, "shellscript"), scripts, tokenize);
    expect(lines.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(
      code.replaceAll("\r\n", "\n"),
    );
    return lines.flat().map((token) => [token.content, token.color]);
  }

  it("colors each nested script with its own grammar, keeping the text", () => {
    expect(colorsOf(`bash -lc "python3 -c 'print(1)'"`)).toEqual([
      [`bash -lc "python3 -c '`, "shellscript"],
      ["print(1)", "python"],
      [`'"`, "shellscript"],
    ]);
  });

  it("colors an escape sequence like the character it spells", () => {
    expect(colorsOf(`bash -c "python3 -c 'print(\\"x\\")'"`)).toContainEqual([
      `print(\\"x\\")`,
      "python",
    ]);
  });

  it("keeps the surrounding colors where a grammar is missing", () => {
    const code = "cat > x.ts <<'EOF'\r\nbody\r\nEOF";
    const [script] = embeddedScripts(code);
    // Compare per character: untouched lines keep their grammar's token boundaries.
    const characterColors = (scripts: ReturnType<typeof embeddedScripts>) =>
      colorsOf(code, scripts).flatMap(([content, color]) => [...content!].map(() => color));
    expect(characterColors([{ ...script!, language: "unknown" }])).toEqual(characterColors([]));
  });
});
