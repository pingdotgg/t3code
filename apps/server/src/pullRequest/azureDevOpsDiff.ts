import { structuredPatch } from "diff";

import type { AzureDevOpsChangeEntry } from "./azureDevOpsPullRequestJson.ts";

/**
 * How far a diff read got, and which push it was reading. Azure hangs a pull request's changed
 * files off an iteration, so the iteration travels with the position: a push landing mid-read
 * would otherwise renumber the list under the cursor and hand the reader a file twice or not at
 * all.
 */
export interface AzureDevOpsDiffCursor {
  readonly iterationId: number;
  readonly fileIndex: number;
}

const CURSOR_SEPARATOR = ":";

/**
 * Both halves are plain decimal, because `Number` is wider than what was written: it reads an
 * empty or padded half as zero and `0x3` as three, so a cursor this did not write would resume
 * from a position nothing ever handed out.
 */
const CURSOR_COMPONENT = /^\d+$/;

export function formatAzureDevOpsDiffCursor(cursor: AzureDevOpsDiffCursor): string {
  return `${cursor.iterationId}${CURSOR_SEPARATOR}${cursor.fileIndex}`;
}

/** Null for anything this did not write, which starts the read from the top rather than failing. */
export function parseAzureDevOpsDiffCursor(
  raw: string | null | undefined,
): AzureDevOpsDiffCursor | null {
  if (raw === null || raw === undefined) return null;
  const [iteration, file, ...rest] = raw.split(CURSOR_SEPARATOR);
  if (rest.length > 0) return null;
  if (iteration === undefined || file === undefined) return null;
  if (!CURSOR_COMPONENT.test(iteration) || !CURSOR_COMPONENT.test(file)) return null;
  const iterationId = Number(iteration);
  const fileIndex = Number(file);
  if (!Number.isSafeInteger(iterationId) || iterationId <= 0) return null;
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return null;
  return { iterationId, fileIndex };
}

/** The two texts of one changed file, empty on whichever side the change does not have. */
export interface AzureDevOpsFileTexts {
  readonly oldContents: string;
  readonly newContents: string;
  /**
   * The host's own word on whether this is a file it will not spell out. Azure hands such a file
   * over base64-encoded, so its bytes are not in the text to be looked for.
   */
  readonly binary: boolean;
}

export interface AzureDevOpsFilePatch {
  readonly section: string;
  /** The file changed but its hunks are not in the section, so the patch has a hole in it. */
  readonly truncated: boolean;
  /**
   * The diff was given up on partway rather than declined on sight, so this file spent the whole
   * of what one file is allowed and produced a header for it. The caller reading a run of files
   * is meant to stop here rather than pay that again for each of the ones behind it.
   */
  readonly abandoned: boolean;
}

/**
 * Beyond this a file is shown as changed without its hunks. Azure hands back whole files rather
 * than a patch, so a generated bundle or a checked-in dump is paid for twice over before anything
 * can be diffed, and nobody reads the result either way.
 */
const MAX_FILE_BYTES = 512 * 1024;

/** Git's own default, and what the hunks from this repo's other hosts are already cut to. */
const PATCH_CONTEXT_LINES = 3;

/**
 * How long one file may be diffed for. The line diff costs the product of the two sides, so a pair
 * of files under the size ceiling that share almost nothing can still hold the whole server for a
 * long time. Past this the file is listed without its hunks, which is what the size ceiling already
 * does and what the reader is already shown a sign of.
 */
export const MAX_FILE_DIFF_MILLIS = 2_000;

/**
 * How much patch one slice carries before the rest is left for the next one. Every file costs a
 * request per side, so the read stops on what it has produced rather than on a file count: a
 * hundred one-line changes are cheaper to finish than three long ones.
 */
export const MAX_DIFF_SLICE_BYTES = 256 * 1024;

/** A NUL byte is git's own test for it, and it survives Azure's JSON envelope intact. */
function isBinary(contents: string): boolean {
  return contents.includes("\u0000");
}

/**
 * What a file costs on the wire, which is its bytes rather than its code units: a ceiling counted
 * in characters lets a file of three-byte glyphs through at three times the size meant to be let
 * through.
 */
export const byteLength = (contents: string) => Buffer.byteLength(contents, "utf8");

/**
 * Git points an empty range at the line before it, which is line zero for a file that is wholly
 * new or wholly gone, and writes a single line as its number alone.
 */
function hunkRange(start: number, lines: number): string {
  if (lines === 0) return `${start - 1},0`;
  return lines === 1 ? String(start) : `${start},${lines}`;
}

/**
 * The `diff --git` preamble a viewer reads a file's identity and fate from. Azure reports no file
 * mode, so the ordinary one stands in, exactly as it does for the GitHub files API here.
 */
function patchHeader(change: AzureDevOpsChangeEntry): string {
  const lines = [`diff --git a/${change.oldPath} b/${change.path}`];
  if (change.changeKind === "new") lines.push("new file mode 100644");
  if (change.changeKind === "deleted") lines.push("deleted file mode 100644");
  if (change.changeKind === "rename-pure" || change.changeKind === "rename-changed") {
    lines.push(`rename from ${change.oldPath}`, `rename to ${change.path}`);
  }
  lines.push(
    `--- ${change.changeKind === "new" ? "/dev/null" : `a/${change.oldPath}`}`,
    `+++ ${change.changeKind === "deleted" ? "/dev/null" : `b/${change.path}`}`,
  );
  return lines.join("\n");
}

/**
 * One file's section of a unified patch, built here because Azure has no route that carries one:
 * its diff routes name the files that changed and their blob ids, and the contents are a separate
 * read per side.
 */
export function azureDevOpsFilePatch(input: {
  readonly change: AzureDevOpsChangeEntry;
  readonly texts: AzureDevOpsFileTexts;
  /** How long this one file may be diffed for, at most what any file is allowed. */
  readonly timeoutMillis?: number;
}): AzureDevOpsFilePatch {
  const header = patchHeader(input.change);
  const { oldContents, newContents } = input.texts;

  if (input.texts.binary || isBinary(oldContents) || isBinary(newContents)) {
    // Git's own wording for a file it will not spell out, which every diff viewer already reads.
    const binary = `Binary files a/${input.change.oldPath} and b/${input.change.path} differ`;
    return { section: `${header}\n${binary}\n`, truncated: true, abandoned: false };
  }
  if (byteLength(oldContents) > MAX_FILE_BYTES || byteLength(newContents) > MAX_FILE_BYTES) {
    return { section: `${header}\n`, truncated: true, abandoned: false };
  }

  const patch = structuredPatch(
    `a/${input.change.oldPath}`,
    `b/${input.change.path}`,
    oldContents,
    newContents,
    undefined,
    undefined,
    {
      context: PATCH_CONTEXT_LINES,
      timeout: Math.min(input.timeoutMillis ?? MAX_FILE_DIFF_MILLIS, MAX_FILE_DIFF_MILLIS),
    },
  );
  // The bound is reported by giving nothing back, and a file whose diff was given up on is a file
  // listed without its hunks rather than a file dropped from the change.
  if (patch === undefined) return { section: `${header}\n`, truncated: true, abandoned: true };

  const hunks = patch.hunks.map((hunk) =>
    [
      `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    ].join("\n"),
  );
  // A pure rename has no hunks to give. It is still listed, because dropping it would take the
  // file out of the change altogether.
  return {
    section: hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.join("\n")}\n`,
    truncated: false,
    abandoned: false,
  };
}

/**
 * A file listed without its hunks, for when the host would not hand one of its two sides over.
 * The change still belongs in the patch: leaving it out would take the file out of the review
 * altogether, and the reader would have no sign anything was missing.
 */
export function azureDevOpsUnreadableFilePatch(
  change: AzureDevOpsChangeEntry,
): AzureDevOpsFilePatch {
  return { section: `${patchHeader(change)}\n`, truncated: true, abandoned: false };
}
