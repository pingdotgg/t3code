import "@t3tools/client-runtime/assembly-highlighting";
import {
  type DiffsHighlighter,
  type DiffsThemeNames,
  getSharedHighlighter,
  type HighlighterTypes,
  renderTokenLines,
  setCustomExtension,
  type SupportedLanguages,
  type ThemedToken,
  type TokensResult,
} from "@pierre/diffs";
import type { ElementContent, Root } from "hast";

/** The board is dark only, so it uses the dark theme of T3's code surfaces. */
export const CODE_THEME = "pierre-dark";

// Highlights has no lexer for these dialects, so they use their base language's.
setCustomExtension("luau", "lua");
setCustomExtension("xsl", "xml");
setCustomExtension("xslt", "xml");

// Only one highlighter type can be active per thread, so every creation site must pass this value.
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "highlights";

const highlighterPromises = new Map<string, Promise<DiffsHighlighter>>();

/** The shared highlighter loaded with one language, or with plain text when the language is unknown. */
export function highlighterFor(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromises.get(language);
  if (cached) return cached;
  const promise = getSharedHighlighter({
    themes: [CODE_THEME],
    // SAFETY: a language the highlighter lacks rejects below, and the block falls back to plain text.
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error) => {
    if (language === "text") {
      highlighterPromises.delete(language);
      throw error;
    }
    return highlighterFor("text");
  });
  highlighterPromises.set(language, promise);
  return promise;
}

function highlightedDocument(
  result: TokensResult,
  lines: ElementContent[] = renderTokenLines(result.tokens, {}),
): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {
          class: "diffs",
          style:
            result.rootStyle === false
              ? undefined
              : (result.rootStyle ??
                [
                  result.fg != null ? `color:${result.fg}` : "",
                  result.bg != null ? `background-color:${result.bg}` : "",
                ]
                  .filter(Boolean)
                  .join(";")),
          tabIndex: 0,
        },
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: lines.flatMap((line, index) =>
              index === 0 ? [line] : [{ type: "text", value: "\n" }, line],
            ),
          },
        ],
      },
    ],
  };
}

export function highlightToHast(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  theme: DiffsThemeNames,
): Root {
  return highlightedDocument(highlighter.codeToTokens(code, { lang: language, theme }));
}

/**
 * Highlights a block that grows by appending, tokenizing only the new text. Lines that are
 * complete keep their node identity, so React leaves their DOM alone while the last line changes.
 */
export function createIncrementalHighlight(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffsThemeNames,
) {
  const options = { lang: language, theme };
  let shell: TokensResult | undefined;
  let tokenizer: ReturnType<DiffsHighlighter["createStreamTokenizer"]> | undefined;
  let previous = "";
  const completedLines: ElementContent[] = [];

  function dispose() {
    tokenizer?.dispose();
    tokenizer = undefined;
    previous = "";
    completedLines.length = 0;
  }

  return Object.assign(
    (code: string): Root => {
      // ANSI and a CR cut mid-sequence need the whole source normalized.
      if (language === "ansi" || code.includes("\r")) {
        dispose();
        return highlightToHast(highlighter, code, language, theme);
      }
      if (!code.startsWith(previous)) dispose();
      // Created on first use so an unknown language throws inside the caller's fallback.
      shell ??= highlighter.codeToTokens("", options);
      tokenizer ??= highlighter.createStreamTokenizer(options);
      const update = tokenizer.enqueue(code.slice(previous.length));
      if (update instanceof Promise) {
        dispose();
        void update.catch(() => {});
        return highlightToHast(highlighter, code, language, theme);
      }
      previous = code;
      let line: ThemedToken[] = [];
      for (const token of update.stable) {
        if (token.content === "\n") {
          completedLines.push(...renderTokenLines([line], {}));
          line = [];
        } else line.push(token);
      }
      return highlightedDocument(shell, [
        ...completedLines,
        ...renderTokenLines([update.unstable], {}),
      ]);
    },
    { dispose },
  );
}

const MAX_CACHED_BLOCKS = 200;

/** The HTML of blocks whose text is final, so a remounted message does not highlight them again. */
const highlightedHtml = new Map<string, string>();

// The key holds the code itself: a hash would let two blocks share one block's HTML.
export const highlightKey = (language: string, code: string) =>
  `${language.length}:${language}:${code}`;

export const cachedHighlight = (key: string) => highlightedHtml.get(key);

export function rememberHighlight(key: string, html: string) {
  if (highlightedHtml.size >= MAX_CACHED_BLOCKS) {
    const oldest = highlightedHtml.keys().next().value;
    if (oldest !== undefined) highlightedHtml.delete(oldest);
  }
  highlightedHtml.set(key, html);
}
