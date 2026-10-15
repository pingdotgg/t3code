import { lazy, Suspense } from "react";

import { texMathAttributes } from "../../markdown-math";
import { RenderErrorBoundary } from "../RenderErrorBoundary";

const KatexMath = lazy(() => import("./KatexMath"));

/**
 * Math classes can also come from fences or authored HTML, so the source at the
 * node's offset must start with a math opener.
 */
export function isTexMath(
  node: { position?: { start: { offset?: number | undefined } } | undefined } | undefined,
  className: string | undefined,
  source: string,
  display: boolean,
): boolean {
  const offset = node?.position?.start.offset;
  return (
    className?.split(/\s+/).includes(display ? "language-math-display" : "language-math-inline") ===
      true &&
    typeof offset === "number" &&
    (display
      ? source.startsWith("\\[", offset) || source.startsWith("$$", offset)
      : source.startsWith("\\(", offset))
  );
}

/** Shows the TeX source while KaTeX loads and when it cannot typeset it or load. */
export function MarkdownMath({ tex, display }: { tex: string; display: boolean }) {
  const attributes = texMathAttributes(tex, display);
  const source = display ? (
    <pre {...attributes}>
      <code>{tex}</code>
    </pre>
  ) : (
    <code {...attributes}>{tex}</code>
  );
  return (
    <RenderErrorBoundary resetKeys={[tex, display]} fallback={source}>
      <Suspense fallback={source}>
        <KatexMath tex={tex} display={display} fallback={source} />
      </Suspense>
    </RenderErrorBoundary>
  );
}
