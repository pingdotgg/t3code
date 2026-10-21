import type { DiffsHighlighter } from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

function codeChildren(root: ReturnType<DiffsHighlighter["codeToHast"]>) {
  const pre = root.children.find((node) => node.type === "element" && node.tagName === "pre");
  if (pre?.type !== "element") throw new Error("Missing highlighted pre element");
  const code = pre.children.find((node) => node.type === "element" && node.tagName === "code");
  if (code?.type !== "element") throw new Error("Missing highlighted code element");
  return code.children;
}

export function createIncrementalHighlightedDocument(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffThemeName,
): (code: string) => ReturnType<DiffsHighlighter["codeToHast"]> {
  const options = { lang: language, theme };
  const newline = { type: "text" as const, value: "\n" };
  let cached:
    | {
        prefix: string;
        state: ReturnType<DiffsHighlighter["getLastGrammarState"]>;
        children: ReturnType<typeof codeChildren>;
      }
    | undefined;

  return (code: string) => {
    // Plain text and ANSI have no grammar state; trailing CR still needs the full path for possible CRLF.
    if (
      !language ||
      ["text", "plaintext", "plain", "txt", "ansi"].includes(language) ||
      code.includes("\r")
    ) {
      return highlighter.codeToHast(code, options);
    }
    if (cached && !code.startsWith(cached.prefix)) cached = undefined;
    const end = code.lastIndexOf("\n") + 1;
    if (end > (cached?.prefix.length ?? 0)) {
      // Omit the last newline so Shiki does not tokenize an extra line and advance state twice.
      const root = highlighter.codeToHast(code.slice(cached?.prefix.length ?? 0, end - 1), {
        ...options,
        ...(cached ? { grammarState: cached.state } : {}),
      });
      const state = highlighter.getLastGrammarState(root);
      if (!state) {
        cached = undefined;
        return highlighter.codeToHast(code, options);
      }
      cached = {
        prefix: code.slice(0, end),
        state,
        children: [...(cached ? [...cached.children, newline] : []), ...codeChildren(root)],
      };
    }
    const prefix = cached;
    if (!prefix) return highlighter.codeToHast(code, options);
    return highlighter.codeToHast(code.slice(prefix.prefix.length), {
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
