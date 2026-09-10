import { memo } from "react";
import { renderMathHtml } from "../mathRendering";
import "katex/dist/katex.min.css";

export default memo(function MathTypeset({ source }: { source: string }) {
  const html = renderMathHtml(source);
  return html === null ? (
    <span className="whitespace-pre-wrap font-mono text-xs">{source}</span>
  ) : (
    <span dangerouslySetInnerHTML={{ __html: html }} />
  );
});
