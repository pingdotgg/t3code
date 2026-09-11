import type { DiffsHighlighter } from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

function codeChildren(root: ReturnType<DiffsHighlighter["codeToHast"]>) {
  const pre = root.children.find((node) => node.type === "element" && node.tagName === "pre");
  if (pre?.type !== "element") throw new Error("Missing highlighted pre element");
  const code = pre.children.find((node) => node.type === "element" && node.tagName === "code");
  if (code?.type !== "element") throw new Error("Missing highlighted code element");
  return code.children;
}

/** Resume tokenization after the last completed line. Keep its grammar state so
 * multiline strings, comments, and embedded languages continue to highlight as
 * they do in a full pass. The current line is always highlighted again.
 */
export function createIncrementalHighlighter(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffThemeName,
) {
  const options = { lang: language, theme };
  const newline = { type: "text" as const, value: "\n" };
  let cached:
    | {
        prefix: string;
        state: ReturnType<DiffsHighlighter["getLastGrammarState"]>;
        children: ReturnType<typeof codeChildren>;
      }
    | undefined;

  return (code: string): string => {
    // Plain text and ANSI do not have a TextMate grammar state. A CR at the end
    // of a chunk can still become a CRLF, so keep that input on the full path.
    if (
      !language ||
      ["text", "plaintext", "plain", "txt", "ansi"].includes(language) ||
      code.includes("\r")
    ) {
      return highlighter.codeToHtml(code, options);
    }
    if (cached && !code.startsWith(cached.prefix)) cached = undefined;
    const end = code.lastIndexOf("\n") + 1;
    if (end > (cached?.prefix.length ?? 0)) {
      // Omit the final newline: Shiki would tokenize an extra empty line and
      // advance the grammar state twice before we process the following line.
      const root = highlighter.codeToHast(code.slice(cached?.prefix.length ?? 0, end - 1), {
        ...options,
        ...(cached ? { grammarState: cached.state } : {}),
      });
      const state = highlighter.getLastGrammarState(root);
      if (!state) {
        cached = undefined;
        return highlighter.codeToHtml(code, options);
      }
      cached = {
        prefix: code.slice(0, end),
        state,
        children: [...(cached ? [...cached.children, newline] : []), ...codeChildren(root)],
      };
    }
    const prefix = cached;
    if (!prefix) return highlighter.codeToHtml(code, options);
    return highlighter.codeToHtml(code.slice(prefix.prefix.length), {
      ...options,
      grammarState: prefix.state,
      transformers: [
        {
          code: (node) => ({ ...node, children: [...prefix.children, newline, ...node.children] }),
        },
      ],
    });
  };
}
