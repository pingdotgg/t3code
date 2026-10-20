import {
  cloneFileDiffMetadata,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

import { useRenderedAppearance } from "~/hooks/useTheme";
import { hideWhitespaceChanges, resolveDiffThemeName } from "~/lib/diffRendering";
import { useClientSettings } from "~/hooks/useSettings";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { GUIDE_DIFF_UNSAFE_CSS } from "./guideDiffStyles";

export function GuideFileDiff({
  file,
  loadDiffFiles,
}: {
  file: FileDiffMetadata;
  loadDiffFiles: FileDiffContentsLoader;
}) {
  const resolvedTheme = useRenderedAppearance();
  const settings = useClientSettings();
  // Loading the unchanged lines rewrites the diff it is given; the excerpts read the same file
  // as a patch, so this view expands a copy of its own.
  const expandable = cloneFileDiffMetadata(
    settings.diffIgnoreWhitespace ? hideWhitespaceChanges(file) : file,
  );
  const options = {
      diffStyle: settings.diffLayout === "split" ? ("split" as const) : ("unified" as const),
    lineDiffType: "none" as const,
      overflow: settings.wordWrap ? ("wrap" as const) : ("scroll" as const),
    disableFileHeader: true,
    theme: resolveDiffThemeName(resolvedTheme),
    themeType: resolvedTheme,
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
      unsafeCSS: GUIDE_DIFF_UNSAFE_CSS,
    loadDiffFiles,
  };
  return (
    <div className="border-t border-border/60">
      <FileDiff fileDiff={expandable} options={options} />
    </div>
  );
}
