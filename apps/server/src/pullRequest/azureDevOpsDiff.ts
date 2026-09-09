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
  /**
   * Lines the diff added or removed, which is the edit distance it had to search out and so what
   * the file cost the thread it ran on. The caller reading a run of files spends a budget of these
   * rather than of bytes: a file of short lines is cheap on the wire and dear to diff.
   */
  readonly edits: number;
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
 * How far apart one file's two sides may be before it is listed without its hunks. The line diff
 * searches for the edit distance and costs about the square of it, so a pair of files under the
 * size ceiling that share almost nothing would otherwise hold the whole server, and every websocket
 * client with it, while it works out a patch of tens of thousands of lines nobody reads. Bounded in
 * edits rather than in milliseconds so a change slices the same way on every machine.
 *
 * Measured at around 210ms for a pair at the size ceiling that shares no line at all, which is the
 * longest this can hold the thread for one file.
 */
export const MAX_FILE_DIFF_EDITS = 2_000;

/**
 * How many lines a file may be listed as wholly replaced by when its diff was given up on. The
 * edit ceiling is a distance rather than a proportion, so a long file can exceed it having changed
 * in one corner only, and calling that a whole replacement would be a wall of red and green hiding
 * the part that moved. Four times the ceiling keeps the claim within reach of what is known to
 * differ: measured against this repository's own history, no section it admits overstates the real
 * change by more than about a factor of two.
 */
const MAX_FULL_REPLACEMENT_LINES = 4 * MAX_FILE_DIFF_EDITS;

/**
 * A backstop for a machine slower than the one the edit ceiling was measured on. Nothing within
 * that ceiling comes near this on ordinary hardware, so it changes no patch; it is only here so
 * the longest one file can hold the thread stays a number rather than a hope.
 */
const MAX_FILE_DIFF_MILLIS = 500;

/**
 * How much diff work one slice does before the rest is left for the next one, which bounds what a
 * single request can cost the thread at this and one more file's worth.
 */
export const MAX_DIFF_SLICE_EDITS = 6_000;

/**
 * How much patch one slice carries before the rest is left for the next one. Every file costs a
 * request per side, so the read stops on what it has produced rather than on a file count: a
 * hundred one-line changes are cheaper to finish than three long ones.
 */
export const MAX_DIFF_SLICE_BYTES = 256 * 1024;

/** Git's own note for a side whose last line has no newline after it. */
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** A text's lines, without the empty one that a trailing newline leaves behind a split. */
function contentLines(contents: string): ReadonlyArray<string> {
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

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
 * A file written out as wholly replaced: every old line gone, every new line arrived, in one hunk.
 * Costs no search at all, around 45ns a line, so it is both the whole patch for a file that has
 * only one side and a stand-in for one whose real diff was given up on.
 */
function replacementSection(header: string, texts: AzureDevOpsFileTexts): string {
  const oldLines = contentLines(texts.oldContents);
  const newLines = contentLines(texts.newContents);
  const noNewline = (contents: string, lines: ReadonlyArray<string>) =>
    lines.length > 0 && !contents.endsWith("\n") ? [NO_NEWLINE_MARKER] : [];
  return [
    header,
    `@@ -${hunkRange(1, oldLines.length)} +${hunkRange(1, newLines.length)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...noNewline(texts.oldContents, oldLines),
    ...newLines.map((line) => `+${line}`),
    ...noNewline(texts.newContents, newLines),
    "",
  ].join("\n");
}

/**
 * The same section, for a file that has two sides and so a real diff that this is only standing in
 * for. Null where the claim would be too loose to make or too heavy to send, leaving the file
 * listed without its hunks.
 */
function boundedReplacementSection(header: string, texts: AzureDevOpsFileTexts): string | null {
  const lines = contentLines(texts.oldContents).length + contentLines(texts.newContents).length;
  if (lines > MAX_FULL_REPLACEMENT_LINES) return null;
  const section = replacementSection(header, texts);
  // One file's worth of bytes, the same ceiling its two sides were each let through under.
  return byteLength(section) > MAX_FILE_BYTES ? null : section;
}

/**
 * One file's section of a unified patch, built here because Azure has no route that carries one:
 * its diff routes name the files that changed and their blob ids, and the contents are a separate
 * read per side.
 */
export function azureDevOpsFilePatch(input: {
  readonly change: AzureDevOpsChangeEntry;
  readonly texts: AzureDevOpsFileTexts;
}): AzureDevOpsFilePatch {
  const header = patchHeader(input.change);
  const { oldContents, newContents } = input.texts;

  if (input.texts.binary || isBinary(oldContents) || isBinary(newContents)) {
    // Git's own wording for a file it will not spell out, which every diff viewer already reads.
    const binary = `Binary files a/${input.change.oldPath} and b/${input.change.path} differ`;
    return { section: `${header}\n${binary}\n`, truncated: true, abandoned: false, edits: 0 };
  }
  if (byteLength(oldContents) > MAX_FILE_BYTES || byteLength(newContents) > MAX_FILE_BYTES) {
    return { section: `${header}\n`, truncated: true, abandoned: false, edits: 0 };
  }

  // Nothing on one side is a creation or a deletion, where the whole file is the change and there
  // is no edit distance to search out: writing both sides is the minimal patch, and it is linear
  // rather than quadratic in the file's length. The edit ceiling has nothing to protect against
  // here, and applying it would abandon a large new file after doing no work worth saving.
  const created = oldContents === "" && newContents !== "";
  const deleted = newContents === "" && oldContents !== "";
  if (created || deleted) {
    const lines = contentLines(created ? newContents : oldContents);
    return {
      section: replacementSection(header, input.texts),
      truncated: false,
      abandoned: false,
      edits: lines.length,
    };
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
      maxEditLength: MAX_FILE_DIFF_EDITS,
      timeout: MAX_FILE_DIFF_MILLIS,
    },
  );
  // The bound is reported by giving nothing back. Such a file is listed as wholly replaced where
  // that is close enough to the truth to say, and listed without its hunks otherwise, rather than
  // dropped from the change. Either way it spent the whole of what one file is allowed to get here,
  // which is what `edits` carries: writing the replacement out costs nothing on top.
  if (patch === undefined) {
    const replaced = boundedReplacementSection(header, input.texts);
    return {
      section: replaced ?? `${header}\n`,
      truncated: true,
      abandoned: true,
      edits: MAX_FILE_DIFF_EDITS,
    };
  }

  let edits = 0;
  const hunks = patch.hunks.map((hunk) => {
    for (const line of hunk.lines) {
      if (line.startsWith("+") || line.startsWith("-")) edits += 1;
    }
    return [
      `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    ].join("\n");
  });
  // A pure rename has no hunks to give. It is still listed, because dropping it would take the
  // file out of the change altogether.
  return {
    section: hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.join("\n")}\n`,
    truncated: false,
    abandoned: false,
    edits,
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
  return { section: `${patchHeader(change)}\n`, truncated: true, abandoned: false, edits: 0 };
}
