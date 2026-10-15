import katex from "katex";
import "katex/dist/katex.min.css";
import type { ReactNode } from "react";

import { texMathAttributes } from "../../markdown-math";

// Loaded lazily with its stylesheet on first use. Input is model output, so trust stays off.
export default function KatexMath({
  tex,
  display,
  fallback,
}: {
  tex: string;
  display: boolean;
  fallback: ReactNode;
}) {
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      trust: false,
      strict: "ignore",
      maxSize: 20,
    });
  } catch {
    return fallback;
  }
  const attributes = texMathAttributes(tex, display);
  return display ? (
    <div
      className="max-w-full overflow-x-auto overflow-y-hidden"
      {...attributes}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <span {...attributes} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
