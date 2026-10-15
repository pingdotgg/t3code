import { lazy, memo, Suspense } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

const MathTypeset = lazy(() => import("./MathTypeset"));

/**
 * One formula from `remarkChatMath`. Shows its TeX until KaTeX loads, and
 * keeps showing it when KaTeX cannot parse it, such as mid-stream. Copying
 * any part of a formula copies its whole TeX source.
 */
export const MarkdownMath = memo(function MarkdownMath(props: {
  tex: string;
  display: boolean;
  focusable?: boolean;
}) {
  const tex = props.tex.trim();
  const source = props.display ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`;
  const fallback = <span className="chat-markdown-math-source">{source}</span>;
  return (
    <span
      className={props.display ? "chat-markdown-math-display" : "chat-markdown-math-inline"}
      data-markdown-math={props.display ? "display" : "inline"}
      data-markdown-copy={props.display ? `${source}\n\n` : source}
      role="group"
      aria-label={props.display ? "Display equation" : "Inline equation"}
    >
      <span
        className="chat-markdown-math-viewport"
        tabIndex={props.focusable === false ? undefined : 0}
        aria-label={props.display ? "Scroll display equation" : "Scroll inline equation"}
      >
        <span className="chat-markdown-math-content">
          <RenderErrorBoundary resetKeys={[tex]} fallback={fallback}>
            <Suspense fallback={fallback}>
              <MathTypeset tex={tex} display={props.display} fallback={fallback} />
            </Suspense>
          </RenderErrorBoundary>
        </span>
      </span>
    </span>
  );
});
