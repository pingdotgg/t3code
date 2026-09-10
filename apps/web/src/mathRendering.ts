import katex from "katex";
import { markdownMath } from "@t3tools/client-runtime/markdown-math";
import { LRUCache } from "./lib/lruCache";

const cache = new LRUCache<{ html: string | null }>(128, 2 * 1024 * 1024);

/** Only generated KaTeX markup reaches innerHTML. Authored HTML never enters this path. */
export function renderMathHtml(source: string): string | null {
  const cached = cache.get(source);
  if (cached) return cached.html;
  const math = markdownMath(source);
  if (!math) return null;
  let html: string | null = null;
  try {
    html = katex.renderToString(math.tex, {
      displayMode: math.display,
      output: "htmlAndMathml",
      throwOnError: true,
      strict: "error",
      trust: false,
      maxExpand: 1000,
      maxSize: 20,
    });
  } catch {
    // Malformed and unsupported expressions remain readable and copyable TeX.
  }
  cache.set(source, { html }, (source.length + (html?.length ?? 0)) * 2);
  return html;
}
