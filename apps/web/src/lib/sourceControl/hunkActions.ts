/**
 * Hunk-level staging: the pure half.
 *
 * `diffPatch.ts` already turns a raw unified diff into hunks and synthesizes a
 * one-hunk patch. This module turns those hunks into what the *diff view* needs
 * to hang an action cluster off each of them:
 *
 *   - which actions a side offers (`hunkActionsForSide`),
 *   - the `git apply` flags each action implies (`hunkApplyFlags`),
 *   - the line the cluster anchors to (`hunkAnchor`),
 *   - and the whole per-hunk descriptor list (`deriveHunkClusters`).
 *
 * The anchor is deliberately the hunk's LAST CHANGE line rather than its first
 * or last body line: change lines are always rendered, while leading/trailing
 * context can be collapsed into an "N unmodified lines" separator, and an
 * annotation anchored to a collapsed line never appears.
 *
 * fork: f4 hunk staging
 */
import { buildHunkPatch, parseFileDiff, type DiffHunk } from "./diffPatch";

/** Which side of the index the open diff is showing. */
export type HunkSide = "staged" | "unstaged";

export type HunkAction = "stage" | "unstage" | "discard";

export interface HunkApplyFlags {
  readonly cached?: boolean;
  readonly reverse?: boolean;
}

/**
 * The §5.5 table, verbatim. `discard` deliberately omits `cached`: it rewrites
 * the worktree, which is exactly why it is the one hunk action that confirms.
 */
export function hunkApplyFlags(action: HunkAction): HunkApplyFlags {
  switch (action) {
    case "stage":
      return { cached: true };
    case "unstage":
      return { cached: true, reverse: true };
    case "discard":
      return { reverse: true };
  }
}

/**
 * Staged hunks can only be unstaged — discarding from the index would have to
 * reverse-apply against the worktree too, which is a file-level operation and
 * belongs to the changes list where it can be backed by a stash.
 */
export function hunkActionsForSide(side: HunkSide): ReadonlyArray<HunkAction> {
  return side === "staged" ? ["unstage"] : ["stage", "discard"];
}

export function hunkActionLabel(action: HunkAction): string {
  switch (action) {
    case "stage":
      return "Stage hunk";
    case "unstage":
      return "Unstage hunk";
    case "discard":
      return "Discard hunk";
  }
}

export type HunkAnchorSide = "additions" | "deletions";

export interface HunkAnchor {
  readonly side: HunkAnchorSide;
  /** File line number on that side — new-file for additions, old-file for deletions. */
  readonly lineNumber: number;
}

/**
 * The last `+`/`-` line of the hunk, in the coordinate space the diff viewer
 * annotates by. `null` for a hunk with no change line at all (a context-only
 * fragment, which cannot be staged and so gets no cluster).
 */
export function hunkAnchor(hunk: DiffHunk): HunkAnchor | null {
  let oldLine = hunk.oldStart - 1;
  let newLine = hunk.newStart - 1;
  let anchor: HunkAnchor | null = null;
  for (const line of hunk.body) {
    const first = line[0];
    if (first === "\\") {
      // "\ No newline at end of file" annotates the previous line and spans none.
      continue;
    }
    if (first === "+") {
      newLine += 1;
      anchor = { side: "additions", lineNumber: newLine };
    } else if (first === "-") {
      oldLine += 1;
      anchor = { side: "deletions", lineNumber: oldLine };
    } else {
      oldLine += 1;
      newLine += 1;
    }
  }
  return anchor;
}

/** `@@ -12,7 +12,9 @@ function foo()` → `@@ -12,7 +12,9 @@`. */
export function hunkRangeLabel(header: string): string {
  const closing = header.indexOf("@@", 2);
  return closing === -1 ? header.trim() : header.slice(0, closing + 2);
}

export interface HunkCluster {
  /** Index into the file's hunks, matching the order the viewer renders them. */
  readonly index: number;
  readonly anchor: HunkAnchor;
  readonly label: string;
  readonly additions: number;
  readonly deletions: number;
  /** The one-hunk patch handed to `workingCopy.applyPatch`. */
  readonly patch: string;
}

/**
 * Parse a single file's raw diff into one descriptor per stageable hunk.
 *
 * `filePath` is used on both sides of the synthesized patch — see
 * `buildHunkPatch`; for a rename the b-side name is the one `git apply
 * --cached` resolves against.
 *
 * The indices are the parse order of the SAME raw text the viewer renders, so
 * cluster `index` and rendered hunk index cannot drift apart.
 */
export function deriveHunkClusters(raw: string, filePath: string): ReadonlyArray<HunkCluster> {
  const parsed = parseFileDiff(raw);
  if (parsed === null) return [];
  const clusters: HunkCluster[] = [];
  parsed.hunks.forEach((hunk, index) => {
    const anchor = hunkAnchor(hunk);
    if (anchor === null) return;
    clusters.push({
      index,
      anchor,
      label: hunkRangeLabel(hunk.header),
      additions: hunk.additions,
      deletions: hunk.deletions,
      patch: buildHunkPatch(filePath, hunk),
    });
  });
  return clusters;
}

/** Stable identity for a cluster's annotation, so adding one never re-lays-out the file. */
export function hunkAnnotationId(fileKey: string, index: number): string {
  return `hunk:${fileKey}:${index}`;
}

/** Busy key for one in-flight hunk action. */
export function hunkBusyKey(index: number, action: HunkAction): string {
  return `hunk:${index}:${action}`;
}
