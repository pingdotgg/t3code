import { lazy, Suspense } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

const MathTypeset = lazy(() => import("./MathTypeset"));

export function mathDisplayMode(className: string | undefined): boolean | undefined {
  const classes = className?.split(/\s+/) ?? [];
  if (!classes.includes("language-math")) return undefined;
  if (classes.includes("math-display")) return true;
  if (classes.includes("math-inline")) return false;
  return undefined;
}

export function MarkdownMath({ tex, display }: { tex: string; display: boolean }) {
  const Tag = display ? "div" : "span";
  const source = display ? `$$\n${tex}\n$$` : `$$${tex}$$`;
  return (
    <Tag
      className={display ? "chat-markdown-math chat-markdown-math-display" : "chat-markdown-math"}
      data-markdown-copy={display ? `${source}\n\n` : source}
    >
      <RenderErrorBoundary resetKeys={[tex, display]} fallback={source}>
        <Suspense fallback={source}>
          <MathTypeset tex={tex} display={display} fallback={source} />
        </Suspense>
      </RenderErrorBoundary>
    </Tag>
  );
}
