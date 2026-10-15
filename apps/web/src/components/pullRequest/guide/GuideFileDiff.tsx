import {
  cloneFileDiffMetadata,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { hideWhitespaceChanges, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { GUIDE_DIFF_UNSAFE_CSS } from "./guideDiffStyles";

/**
 * A whole file's diff inside a stop, for a file the guide vouched for without excerpting. The row
 * above it names the file, so the renderer's own header is left off. The bars between hunks load
 * the unchanged lines, as in the Code tab.
 */
export function GuideFileDiff({
  file,
  loadDiffFiles,
}: {
  file: FileDiffMetadata;
  loadDiffFiles: FileDiffContentsLoader;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  // Loading the unchanged lines rewrites the diff it is given; the excerpts read the same file
  // as a patch, so this view expands a copy of its own.
  const expandable = useMemo(
    () => cloneFileDiffMetadata(settings.diffIgnoreWhitespace ? hideWhitespaceChanges(file) : file),
    [file, settings.diffIgnoreWhitespace],
  );
  const options = useMemo(
    () => ({
      diffStyle: settings.diffLayout === "split" ? ("split" as const) : ("unified" as const),
      lineDiffType: "none" as const,
      overflow: settings.wordWrap ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      unsafeCSS: GUIDE_DIFF_UNSAFE_CSS,
      loadDiffFiles,
    }),
    [loadDiffFiles, resolvedTheme, settings.diffLayout, settings.wordWrap],
  );
  return (
    <div className="border-t border-border/60">
      <FileDiff fileDiff={expandable} options={options} />
    </div>
  );
}
