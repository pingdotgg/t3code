import { use, type CSSProperties } from "react";

import {
  withEmbeddedScripts,
  type EmbeddedScript,
  type SyntaxToken,
} from "@t3tools/client-runtime/work-log/embedded-scripts";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";

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

/** Suspends during grammar loading; use plain text as the Suspense fallback. */
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
  for (const script of embedded) use(getSyntaxHighlighterPromise(script.language));
  const themeName = resolveDiffThemeName(theme);
  const tokenize = (text: string, lang: string) =>
    highlighter.codeToTokens(text, { lang, theme: themeName }).tokens;
  const lines = keyedLines(
    code,
    withEmbeddedScripts(code, tokenize(code, language), embedded, tokenize),
  );

  // The compiler requires JSX to recognize this component; `use` alone does not suffice.
  return (
    <>
      {lines.map(({ key, tokens, ending }) => (
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
      ))}
    </>
  );
}

/** Restore CRLF from source; Shiki strips both line-ending forms. */
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
