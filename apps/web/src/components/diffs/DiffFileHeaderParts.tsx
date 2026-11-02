import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiffIcon, FileMinusIcon, FilePlusIcon } from "lucide-react";

import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";

/**
 * Pieces the diff viewers slot into Pierre's file header, shared by the thread diff panel and
 * the pull request Code tab. Pierre's own change glyph and line counts are hidden by the shared
 * stylesheet in StyledDiffCodeView; these replace them.
 */

/** The file's change type as a lucide glyph: modified and renamed, added, or deleted. */
export function DiffFileChangeIcon({ type }: { type: FileDiffMetadata["type"] }) {
  if (type === "new") {
    return <FilePlusIcon aria-hidden className="size-3.5 shrink-0 text-diff-addition-foreground" />;
  }
  if (type === "deleted") {
    return (
      <FileMinusIcon aria-hidden className="size-3.5 shrink-0 text-diff-deletion-foreground" />
    );
  }
  return <FileDiffIcon aria-hidden className="size-3.5 shrink-0 text-diff-modified" />;
}

/**
 * The file's basename, shown in place of Pierre's full-path title once the header is narrower
 * than 32rem. The header is the query container (see StyledDiffCodeView), and the stylesheet
 * hides the full title at the same width. `data-diff-file-title` carries the full path for the
 * header's click and context-menu handlers.
 */
export function DiffFileBasename({ path }: { path: string }) {
  const basename = path.slice(path.lastIndexOf("/") + 1) || path;
  return (
    <span
      data-diff-file-title={path}
      className="hidden min-w-0 cursor-pointer truncate font-sans text-foreground @max-lg:inline"
    >
      {basename}
    </span>
  );
}

/** Line counts for a header: additions before deletions, compact past a thousand. */
export function DiffFileHeaderStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (!hasNonZeroStat({ additions, deletions })) return null;
  return <DiffStatLabel font="mono" layout="inline" additions={additions} deletions={deletions} />;
}

/** Sums a parsed file's hunks, the counts Pierre would have drawn itself. */
export function fileDiffLineStat(fileDiff: FileDiffMetadata): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

/**
 * The full path of the header title an event went through, whether it hit Pierre's title or the
 * narrow basename. Takes the event's `composedPath()` because the title lives in a shadow root.
 */
export function diffHeaderTitlePath(composedPath: ReadonlyArray<EventTarget>): string | undefined {
  for (const node of composedPath) {
    if (!(node instanceof HTMLElement)) continue;
    const basenamePath = node.getAttribute("data-diff-file-title");
    if (basenamePath) return basenamePath;
    if (node.hasAttribute("data-title")) return node.textContent ?? undefined;
  }
  return undefined;
}
