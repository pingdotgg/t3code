import { File } from "@pierre/diffs/react";
import { memo, useMemo, type ReactNode } from "react";
import type { DiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

const CODE_BLOCK_CSS = `
:host {
  --diffs-font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  background: transparent;
  --diffs-gap-inline: 0px;
}
[data-code] { padding: 0.8rem 0.9rem; }
`;

/** Code fences share the diff viewers' workers, queue, and stale-result handling. */
export const MarkdownCodeHighlight = memo(function MarkdownCodeHighlight({
  code,
  language,
  themeName,
  wrapped,
  isStreaming,
  fallback,
}: {
  code: string;
  language: string;
  themeName: DiffThemeName;
  wrapped: boolean;
  isStreaming: boolean;
  fallback: ReactNode;
}) {
  const file = useMemo(
    () => ({
      name: "code",
      contents: code,
      lang: language,
      // Only completed fences enter the shared bounded AST cache.
      ...(isStreaming ? {} : { cacheKey: JSON.stringify(["markdown", language, code]) }),
    }),
    [code, language, isStreaming],
  );
  return (
    <DiffWorkerPoolProvider fallback={fallback}>
      <div data-markdown-code={code} data-language={language}>
        <File
          file={file}
          options={{
            theme: themeName,
            themeType: themeName === "pierre-dark" ? "dark" : "light",
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            disableFileHeader: true,
            disableLineNumbers: true,
            overflow: wrapped ? "wrap" : "scroll",
            unsafeCSS: CODE_BLOCK_CSS,
          }}
        />
      </div>
    </DiffWorkerPoolProvider>
  );
});
