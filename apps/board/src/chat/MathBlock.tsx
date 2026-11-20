import { lazy, memo, Suspense } from "react";

import { RenderErrorBoundary } from "./RenderErrorBoundary";

const MathTypeset = lazy(() => import("./MathTypeset"));

/**
 * One formula from `remark-math`. Shows its TeX until KaTeX loads, and keeps showing it when KaTeX
 * cannot parse it, such as mid-stream. Copying any part of a formula copies its whole TeX source.
 */
export const MathBlock = memo(function MathBlock({
  tex,
  display,
}: {
  tex: string;
  display: boolean;
}) {
  const source = display ? `\\[\n${tex.trim()}\n\\]` : `\\(${tex.trim()}\\)`;
  const fallback = <span className="whitespace-pre-wrap">{source}</span>;
  return (
    <span
      className={
        display
          ? "my-2.5 block max-w-full overflow-x-auto overflow-y-hidden"
          : "inline-block max-w-full align-middle whitespace-nowrap"
      }
      data-markdown-math={display ? "display" : "inline"}
      role="group"
      aria-label={display ? "Display equation" : "Inline equation"}
    >
      <RenderErrorBoundary resetKeys={[tex]} fallback={fallback}>
        <Suspense fallback={fallback}>
          <MathTypeset tex={tex.trim()} display={display} fallback={fallback} />
        </Suspense>
      </RenderErrorBoundary>
    </span>
  );
});
