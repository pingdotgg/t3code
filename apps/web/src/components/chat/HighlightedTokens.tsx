import { use, useMemo, type CSSProperties } from "react";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";

interface SyntaxToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string;
  readonly fontStyle?: number;
}

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
 * `wordClassName` goes on each whitespace-separated word.
 */
export function HighlightedTokens({
  code,
  language,
  theme,
  wordClassName,
}: {
  code: string;
  language: string;
  theme: "light" | "dark";
  wordClassName?: string;
}) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const lines = useMemo(
    () =>
      keyedLines(
        highlighter.codeToTokens(code, { lang: language, theme: resolveDiffThemeName(theme) })
          .tokens,
      ),
    [code, highlighter, language, theme],
  );

  return lines.map(({ key, tokens }, index) => (
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
      {index < lines.length - 1 ? "\n" : null}
    </span>
  ));
}

/** Keys each line by its start offset, which stays unique when several lines are empty. */
function keyedLines<Token extends SyntaxToken>(lines: ReadonlyArray<ReadonlyArray<Token>>) {
  let lineStart = 0;
  return lines.map((tokens) => {
    const text = tokens.map((token) => token.content).join("");
    const key = `${lineStart}:${text}`;
    lineStart += text.length + 1;
    return { key, tokens };
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
