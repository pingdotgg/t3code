import { resolveHighlightLanguage } from "../lib/highlightLanguage";

// Fences enriched-markdown colours itself: cpp/highlight/CodeBlockLanguages.cpp entries with a default grammar.
const NATIVE_HIGHLIGHT_FENCES = new Set([
  "bash",
  "c",
  "css",
  "go",
  "golang",
  "html",
  "java",
  "javascript",
  "js",
  "json",
  "jsx",
  "markdown",
  "md",
  "py",
  "python",
  "rs",
  "rust",
  "sh",
  "shell",
  "ts",
  "tsx",
  "typescript",
  "yaml",
  "yml",
  "zsh",
]);

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
  | { readonly kind: "highlight"; readonly language: string }
  | { readonly kind: "native" };

/** Mermaid and math fences first: highlights knows `mermaid` too, and would claim it as code. */
export function codeFenceRenderer(fence: string, mathRenderingEnabled: boolean): CodeFenceRenderer {
  if (fence === "mermaid") return { kind: "mermaid" };
  if (fence === "math" && mathRenderingEnabled) return { kind: "math" };
  const name = fence.toLowerCase();
  if (NATIVE_HIGHLIGHT_FENCES.has(name)) return { kind: "native" };
  const language = resolveHighlightLanguage({ language: name });
  return language === "text" ? { kind: "native" } : { kind: "highlight", language };
}
