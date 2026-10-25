import {
  renderTokenLines,
  type DiffsHighlighter,
  type ThemedToken,
  type TokensResult,
} from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

function highlightedDocument(
  result: TokensResult,
  lines = renderTokenLines(result.tokens, {}),
): { type: "root"; children: ReturnType<typeof renderTokenLines> } {
  return {
    type: "root" as const,
    children: [
      {
        type: "element" as const,
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
            type: "element" as const,
            tagName: "code",
            properties: {},
            children: lines.flatMap((line, index) =>
              index === 0 ? [line] : [{ type: "text" as const, value: "\n" }, line],
            ),
          },
        ],
      },
    ],
  };
}

export function highlightCodeToHast(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  theme: DiffThemeName,
) {
  return highlightedDocument(highlighter.codeToTokens(code, { lang: language, theme }));
}

export function createIncrementalHighlightedDocument(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffThemeName,
) {
  const options = { lang: language, theme };
  let shell: TokensResult | undefined;
  let tokenizer: ReturnType<DiffsHighlighter["createStreamTokenizer"]> | undefined;
  let previous = "";
  const completedLines: ReturnType<typeof renderTokenLines> = [];

  function dispose() {
    tokenizer?.dispose();
    tokenizer = undefined;
    previous = "";
    completedLines.length = 0;
  }

  return Object.assign(
    (code: string) => {
      // ANSI and partial CRLF sequences need the full-source normalization path.
      if (language === "ansi" || code.includes("\r")) {
        dispose();
        return highlightCodeToHast(highlighter, code, language, theme);
      }
      if (!code.startsWith(previous)) dispose();
      // Created on first use so an unknown language throws inside the caller's fallback.
      shell ??= highlighter.codeToTokens("", options);
      tokenizer ??= highlighter.createStreamTokenizer(options);
      const update = tokenizer.enqueue(code.slice(previous.length));
      if (update instanceof Promise) {
        dispose();
        void update.catch(() => {});
        return highlightCodeToHast(highlighter, code, language, theme);
      }
      previous = code;
      let line: ThemedToken[] = [];
      for (const token of update.stable) {
        if (token.content === "\n") {
          completedLines.push(...renderTokenLines([line], {}));
          line = [];
        } else line.push(token);
      }
      // Completed line nodes retain their identity while the final line changes.
      return highlightedDocument(shell, [
        ...completedLines,
        ...renderTokenLines([update.unstable], {}),
      ]);
    },
    { dispose },
  );
}
