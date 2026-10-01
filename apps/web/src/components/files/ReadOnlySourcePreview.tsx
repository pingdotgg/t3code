import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useTheme } from "~/hooks/useTheme";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

/**
 * Highlighted source for files that cannot be edited: truncated reads.
 * Same surface theme, word-wrap preference and virtualization as the
 * editable workspace file.
 */
export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly wordWrap: boolean;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<unknown>["onPostRender"];
}) {
  const { resolvedTheme } = useTheme();
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        key={`${props.name}:${resolvedTheme}:${props.text.length}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={{
            name: props.name,
            contents: props.text,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          options={{
            disableFileHeader: true,
            overflow: props.wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
            ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}
