import katex from "katex";
import "katex/dist/katex.min.css";
import type { ReactNode } from "react";

import { LRUCache } from "../../lib/lruCache";

// Virtualized threads remount messages while scrolling; cached markup keeps
// that from typesetting the same formulas again. "" records a parse error.
const typesetCache = new LRUCache<string>(1000, 4 * 1024 * 1024);

function typeset(tex: string, display: boolean): string {
  const key = `${display ? "display" : "inline"}:${tex}`;
  const cached = typesetCache.get(key);
  if (cached !== null) return cached;
  let html = "";
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      // No \href, \url, \htmlClass, or other commands that emit active HTML.
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch {
    // Unfinished or unsupported TeX stays readable as its source.
  }
  typesetCache.set(key, html, (key.length + html.length) * 2);
  return html;
}

/** KaTeX lives in this lazily loaded chunk, so it is only fetched once a formula renders. */
export default function MathTypeset(props: { tex: string; display: boolean; fallback: ReactNode }) {
  const html = typeset(props.tex, props.display);
  if (!html) return props.fallback;
  // KaTeX escapes the TeX it renders, and `trust: false` keeps it from emitting links or attributes.
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
