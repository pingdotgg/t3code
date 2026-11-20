import { resolveHighlightLanguage } from "../lib/highlightLanguage";

/** A fenced code block for `code`, with a backtick fence longer than any backtick run inside it. */
export function fencedCodeMarkdown(code: string, language: string): string {
  let longestRun = 0;
  for (const [run] of code.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

type CodeFenceRenderer =
  | { readonly kind: "mermaid" }
  | { readonly kind: "math" }
  | { readonly kind: "highlight"; readonly language: string };

/**
 * Mermaid and math fences first: highlights knows `mermaid` too, and would claim it as code.
 * Every other fence is drawn in React, so one header and one set of actions cover all code;
 * enriched-markdown's own block has a fixed header with a divider.
 */
export function codeFenceRenderer(fence: string, mathRenderingEnabled: boolean): CodeFenceRenderer {
  if (fence === "mermaid") return { kind: "mermaid" };
  if (fence === "math" && mathRenderingEnabled) return { kind: "math" };
  return {
    kind: "highlight",
    language: resolveHighlightLanguage({ language: fence.toLowerCase() }),
  };
}
