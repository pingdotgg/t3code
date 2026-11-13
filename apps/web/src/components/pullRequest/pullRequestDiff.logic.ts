import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide } from "@t3tools/contracts";

/** Only rendered hunks can anchor comments; list others off-diff. */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number,
): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

export type DiffFoldOverride = "expanded" | "folded" | null;

/** The reader's own fold choice per file. It is absolute, so a Viewed mark loading later keeps it. */
export type FileDiffFoldChoices = ReadonlyMap<string, boolean>;

/**
 * A reader's own choice wins. Otherwise the toolbar decides, and a file still marked Viewed
 * starts folded. Fold all and Expand all clear the choices, so later pages follow the toolbar.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  choices: FileDiffFoldChoices,
  viewed = false,
): boolean {
  return choices.get(fileKey) ?? (foldOverride === "folded" || viewed);
}

export function withFileDiffFold(
  choices: FileDiffFoldChoices,
  fileKey: string,
  collapsed: boolean,
): FileDiffFoldChoices {
  if (choices.get(fileKey) === collapsed) return choices;
  return new Map(choices).set(fileKey, collapsed);
}

export function getFileViewedRange<T extends { readonly fileKey: string }>(
  files: ReadonlyArray<T>,
  fileKey: string,
  anchorFileKey: string | null,
): ReadonlyArray<T> {
  const index = files.findIndex((file) => file.fileKey === fileKey);
  if (index === -1) return [];
  const anchorIndex = files.findIndex((file) => file.fileKey === anchorFileKey);
  if (anchorIndex === -1) return files.slice(index, index + 1);
  return files.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1);
}

interface DiffPage {
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
}

export function isSameDiffPage(left: DiffPage, right: DiffPage): boolean {
  return (
    left.cursor === right.cursor &&
    left.patch === right.patch &&
    left.truncated === right.truncated &&
    left.nextCursor === right.nextCursor &&
    left.omittedFileStats.length === right.omittedFileStats.length &&
    left.omittedFileStats.every((file, index) => {
      const other = right.omittedFileStats[index];
      return (
        other !== undefined &&
        other.path === file.path &&
        other.additions === file.additions &&
        other.deletions === file.deletions
      );
    })
  );
}

/** A refresh under way: the pages re-read so far, and how many the reader had loaded. */
export interface DiffRevalidation<Page> {
  readonly fresh: ReadonlyArray<Page>;
  readonly depth: number;
}

/**
 * A refresh re-reads the loaded pages in order, each from the cursor the page before it just
 * returned, and shows them together: old cursors can belong to the old diff. It reads on past
 * the loaded depth until it has the reader's file, which a file added above can push a page on.
 */
export function revalidateDiffPage<Page extends DiffPage>(
  revalidation: DiffRevalidation<Page>,
  page: Page,
  holdsReadersFile: boolean,
):
  | { readonly pages: ReadonlyArray<Page> }
  | { readonly revalidation: DiffRevalidation<Page>; readonly cursor: string } {
  const fresh = [...revalidation.fresh, page];
  if (page.nextCursor === null || (fresh.length >= revalidation.depth && holdsReadersFile)) {
    return { pages: fresh };
  }
  return { revalidation: { fresh, depth: revalidation.depth }, cursor: page.nextCursor };
}
