import katex from "katex";
import { memo, useMemo } from "react";
import "katex/dist/katex.min.css";

/** Loaded only for formulas; keep both the typesetter and its fonts out of ordinary chat. */
export default memo(function MarkdownMath({
  code,
  displayMode,
}: {
  code: string;
  displayMode: boolean;
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(code, {
        displayMode,
        throwOnError: true,
        trust: false,
        strict: "ignore",
        maxSize: 10,
        maxExpand: 1000,
      });
    } catch {
      // Invalid or still-streaming TeX remains readable instead of breaking the message.
      return null;
    }
  }, [code, displayMode]);

  return html === null ? <code>{code}</code> : <span dangerouslySetInnerHTML={{ __html: html }} />;
});
