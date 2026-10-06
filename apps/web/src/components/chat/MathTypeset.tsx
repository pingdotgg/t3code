import katex from "katex";
import { useMemo } from "react";
import "katex/dist/katex.min.css";

export default function MathTypeset({
  tex,
  display,
  fallback,
}: {
  tex: string;
  display: boolean;
  fallback: string;
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        maxExpand: 1000,
        maxSize: 20,
      });
    } catch {
      return null;
    }
  }, [tex, display]);
  return html === null ? <>{fallback}</> : <span dangerouslySetInnerHTML={{ __html: html }} />;
}
