import { use, useMemo, type CSSProperties } from "react";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import type { EmbeddedScript } from "../../lib/embeddedScripts";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";

interface SyntaxToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string;
  readonly fontStyle?: number;
}

type TokenLines = ReadonlyArray<ReadonlyArray<SyntaxToken>>;

const NO_EMBEDDED_SCRIPTS: ReadonlyArray<EmbeddedScript> = [];

function syntaxTokenStyle(token: SyntaxToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  };
}

/**
 * Colors `code` inside the caller's `<pre>` without changing its text, so
 * selection and copy match the plain version. Suspends while the grammar
 * loads; wrap it in Suspense with the plain text as the fallback.
 * `wordClassName` goes on each whitespace-separated word. `embedded`
 * scripts are colored with their own grammar inside `code`.
 */
export function HighlightedTokens({
  code,
  language,
  embedded = NO_EMBEDDED_SCRIPTS,
  theme,
  wordClassName,
}: {
  code: string;
  language: string;
  embedded?: ReadonlyArray<EmbeddedScript>;
  theme: "light" | "dark";
  wordClassName?: string;
}) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  // Every grammar loads into the same shared highlighter.
  for (const script of embedded) use(getSyntaxHighlighterPromise(script.language));
  const lines = useMemo(() => {
    const themeName = resolveDiffThemeName(theme);
    const tokenize = (text: string, lang: string) =>
      highlighter.codeToTokens(text, { lang, theme: themeName }).tokens;
    return keyedLines(
      code,
      withEmbeddedScripts(code, tokenize(code, language), embedded, tokenize),
    );
  }, [code, embedded, highlighter, language, theme]);

  return lines.map(({ key, tokens, ending }) => (
    <span key={key}>
      {wordClassName
        ? wordsOf(tokens).map((part) =>
            typeof part === "string" ? (
              part
            ) : (
              <span key={part.key} className={wordClassName}>
                {part.pieces.map((piece) => (
                  <span key={piece.key} style={syntaxTokenStyle(piece.token)}>
                    {piece.text}
                  </span>
                ))}
              </span>
            ),
          )
        : tokens.map((token) => (
            <span key={`${token.offset}:${token.content}`} style={syntaxTokenStyle(token)}>
              {token.content}
            </span>
          ))}
      {ending}
    </span>
  ));
}

/**
 * Recolors each embedded script's span of `code` with its own grammar,
 * outermost first so nested scripts win. A script whose grammar is missing
 * keeps the colors around it.
 */
export function withEmbeddedScripts(
  code: string,
  lines: TokenLines,
  embedded: ReadonlyArray<EmbeddedScript>,
  tokenize: (text: string, language: string) => TokenLines,
): TokenLines {
  if (embedded.length === 0) return lines;
  const styles = Array.from<SyntaxToken | undefined>({ length: code.length });
  for (const token of lines.flat()) {
    styles.fill(token, token.offset, token.offset + token.content.length);
  }
  for (const script of embedded) {
    let scriptLines: TokenLines;
    try {
      scriptLines = tokenize(script.text, script.language);
    } catch {
      continue;
    }
    for (const token of scriptLines.flat()) {
      if (token.content === "") continue;
      const last = token.offset + token.content.length - 1;
      styles.fill(token, script.starts[token.offset], script.ends[last]);
    }
  }
  return restyledLines(code, styles);
}

/** Splits `code` into lines of tokens, one per run of characters sharing a style. */
function restyledLines(
  code: string,
  styles: ReadonlyArray<SyntaxToken | undefined>,
): SyntaxToken[][] {
  const lines: SyntaxToken[][] = [];
  let start = 0;
  for (const lineBreak of [...code.matchAll(/\r?\n/gu), undefined]) {
    const end = lineBreak?.index ?? code.length;
    const tokens: SyntaxToken[] = [];
    for (let index = start; index < end;) {
      const style = styles[index];
      let next = index + 1;
      while (
        next < end &&
        styles[next]?.color === style?.color &&
        styles[next]?.fontStyle === style?.fontStyle
      ) {
        next += 1;
      }
      tokens.push({
        content: code.slice(index, next),
        offset: index,
        ...(style?.color ? { color: style.color } : {}),
        ...(style?.fontStyle ? { fontStyle: style.fontStyle } : {}),
      });
      index = next;
    }
    lines.push(tokens);
    if (lineBreak) start = lineBreak.index + lineBreak[0].length;
  }
  return lines;
}

/**
 * Keys each line by its start offset, which stays unique when several lines
 * are empty, and pairs it with the line ending `code` has after it. Shiki drops
 * `\n` and `\r\n` from tokens alike, so CRLF has to come back from the source.
 */
export function keyedLines<Token extends SyntaxToken>(
  code: string,
  lines: ReadonlyArray<ReadonlyArray<Token>>,
) {
  const endings = code.match(/\r?\n/gu) ?? [];
  let lineStart = 0;
  return lines.map((tokens, index) => {
    const text = tokens.map((token) => token.content).join("");
    const key = `${lineStart}:${text}`;
    const ending = endings[index] ?? "";
    lineStart += text.length + ending.length;
    return { key, tokens, ending };
  });
}

interface Word {
  readonly key: string;
  readonly pieces: Array<{ key: string; text: string; token: SyntaxToken }>;
}

/**
 * Regroups a line's tokens into whitespace runs and whole words, matching
 * `text.split(/(\s+)/)`, so a word made of several tokens (`"$HOME/x"`) wraps
 * exactly like its plain-text fallback.
 */
export function wordsOf(tokens: ReadonlyArray<SyntaxToken>): Array<string | Word> {
  const parts: Array<string | Word> = [];
  let word: Word | null = null;
  for (const token of tokens) {
    let offset = token.offset;
    for (const text of token.content.split(/(\s+)/u)) {
      if (text === "") continue;
      if (/^\s/u.test(text)) {
        parts.push(text);
        word = null;
      } else {
        if (!word) {
          word = { key: String(offset), pieces: [] };
          parts.push(word);
        }
        word.pieces.push({ key: String(offset), text, token });
      }
      offset += text.length;
    }
  }
  return parts;
}
