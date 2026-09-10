import { lazy, memo, Suspense, useState } from "react";
import { markdownMath } from "@t3tools/client-runtime/markdown-math";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

// The renderer and its fonts are loaded only when a message contains math.
const MathTypeset = lazy(() => import("./MathTypeset"));

export const MarkdownMath = memo(function MarkdownMath({ source }: { source: string }) {
  const math = markdownMath(source);
  const [showSource, setShowSource] = useState(false);
  if (!math) return <>{source}</>;
  const fallback = <span className="whitespace-pre-wrap font-mono text-xs">{source}</span>;
  return (
    <span
      className={
        math.display
          ? "markdown-math markdown-math-display group/math relative my-[1.25em] block min-w-0 text-inherit"
          : "markdown-math text-inherit"
      }
      data-markdown-math=""
      data-markdown-copy={source}
    >
      {math.display ? (
        <span className="markdown-math-actions flex justify-end gap-[0.9em] text-xs opacity-0 select-none group-hover/math:opacity-100 group-focus-within/math:opacity-100 [@media(hover:none)]:opacity-100">
          <Button
            variant="link"
            size="xs"
            type="button"
            onClick={() => {
              if (!navigator.clipboard) {
                toastManager.add({ type: "error", title: "Could not copy TeX" });
                return;
              }
              void navigator.clipboard.writeText(source).then(
                () => toastManager.add({ type: "success", title: "TeX copied" }),
                () => toastManager.add({ type: "error", title: "Could not copy TeX" }),
              );
            }}
          >
            Copy TeX
          </Button>
          <Button
            variant="link"
            size="xs"
            type="button"
            aria-expanded={showSource}
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? "Hide source" : "TeX source"}
          </Button>
        </span>
      ) : null}
      <span
        className={
          math.display
            ? "markdown-math-viewport block overflow-x-auto py-[0.5em]"
            : "markdown-math-viewport"
        }
        tabIndex={math.display ? 0 : undefined}
        role={math.display ? "region" : undefined}
        aria-label={math.display ? "Equation" : undefined}
      >
        <RenderErrorBoundary fallback={fallback} resetKeys={[source]}>
          <Suspense fallback={fallback}>
            <MathTypeset source={source} />
          </Suspense>
        </RenderErrorBoundary>
      </span>
      {showSource && math.display ? (
        <span className="markdown-math-source mt-[0.5em] block font-mono text-xs wrap-anywhere whitespace-pre-wrap">
          {source}
        </span>
      ) : null}
    </span>
  );
});
