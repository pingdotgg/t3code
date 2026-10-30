import { lazy, memo, Suspense } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

const MathTypeset = lazy(() => import("./MathTypeset"));

/**
 * One formula from `remark-math`. Shows its TeX until KaTeX loads, and
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
  const fallback = <span className="whitespace-pre-wrap">{source}</span>;
  return (
    <span
      className={
        props.display
          ? "chat-markdown-math-display my-[0.65rem] block in-[.chat-markdown-table-container]:max-w-none in-[.chat-markdown-table-container]:overflow-visible"
          : "inline-block max-w-full align-middle whitespace-nowrap wrap-normal break-normal in-[.chat-markdown-table-container]:max-w-none in-[.chat-markdown-table-container]:overflow-visible"
      }
      data-markdown-math={props.display ? "display" : "inline"}
      data-markdown-copy={props.display ? `${source}\n\n` : source}
      role={props.focusable === false ? undefined : "group"}
      aria-label={
        props.focusable === false
          ? undefined
          : props.display
            ? "Display equation"
            : "Inline equation"
      }
    >
      <span
        className="block max-w-full overflow-x-auto overflow-y-hidden in-[.chat-markdown-table-container]:max-w-none in-[.chat-markdown-table-container]:overflow-visible px-0.5 py-0.75 focus-visible:outline-1 focus-visible:outline-solid focus-visible:-outline-offset-1 focus-visible:outline-border [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:border [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-clip-content"
        tabIndex={props.focusable === false ? -1 : 0}
        aria-label={
          props.focusable === false
            ? undefined
            : props.display
              ? "Scroll display equation"
              : "Scroll inline equation"
        }
      >
        <span className={props.display ? "inline-block w-max min-w-full" : "inline-block w-max"}>
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
