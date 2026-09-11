import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
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
 * Measured over nine runs on a pair at the size ceiling that shares no line at all: 359ms at
 * best, 438ms typical, 1223ms at worst. The dearest input this ceiling still admits, at 1998
 * edits, was seen once at 2251ms on a loaded machine, and that is the longest one file can hold
 * the thread for.
 */
export const MAX_FILE_DIFF_EDITS = 2_000;

/**
 * A backstop for a machine slower than any the edit ceiling was measured on, and the reason the
 * ceiling rather than this is what decides a patch's shape: a timeout that fires decides that
 * shape by how fast the machine is, so the same change would slice one way here and another on a
 * busier host, and a file the ceiling admits would lose its hunks on the slower of the two.
 *
 * Headroom over the ceiling is about twice its typical cost rather than the several times it
 * would take to put this out of reach, and the dearest input the ceiling admits has been seen
 * past this value under load. It holds in practice: thirty runs of that input lost no hunks here,
 * against nineteen of thirty at 500ms.
 */
const MAX_FILE_DIFF_MILLIS = 2_000;

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

/**
 * How many files one slice carries however little each one weighs. A binary, oversize, purely
 * renamed or unreadable entry is a header and nothing else, a couple of hundred bytes with no
 * edits at all, so neither budget above stops a run of them until well over a thousand have piled
 * up and the request has spent two reads on each. A change of vendored or generated assets is
 * exactly that shape, and a listing may hold ten thousand entries of it.
 */
export const MAX_DIFF_SLICE_FILES = 300;

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
 *
 * The names are written the way git writes them, quoted where the name holds anything a header
 * cannot carry plainly. Azure names a file in JSON, where a tab or a newline is just another
 * character, and a reader of the header takes the name to stop at the first of either: written as
 * itself, such a file is read under a shorter name than it has, and the viewed mark a reader puts
 * on it is put on a path the host has never heard of.
 *
 * A side's `a/` or `b/` goes inside the quoting, as git puts it, because the quoting is of the
 * whole token the reader takes off the line. A rename states its names with no side to them.
 */
function patchHeader(change: AzureDevOpsChangeEntry): string {
  const oldSide = quoteGitPatchPath(`a/${change.oldPath}`);
  const newSide = quoteGitPatchPath(`b/${change.path}`);
  const lines = [`diff --git ${oldSide} ${newSide}`];
  if (change.changeKind === "new") lines.push("new file mode 100644");
  if (change.changeKind === "deleted") lines.push("deleted file mode 100644");
  if (change.changeKind === "rename-pure" || change.changeKind === "rename-changed") {
    lines.push(
      `rename from ${quoteGitPatchPath(change.oldPath)}`,
      `rename to ${quoteGitPatchPath(change.path)}`,
    );
  }
  lines.push(
    `--- ${change.changeKind === "new" ? "/dev/null" : oldSide}`,
    `+++ ${change.changeKind === "deleted" ? "/dev/null" : newSide}`,
  );
  return lines.join("\n");
}

/**
 * A file written out as wholly replaced: every old line gone, every new line arrived, in one hunk.
 * Costs no search at all, around 45ns a line, which is what makes it the whole patch for a file
 * that has only one side.
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
    const oldSide = quoteGitPatchPath(`a/${input.change.oldPath}`);
    const newSide = quoteGitPatchPath(`b/${input.change.path}`);
    const binary = `Binary files ${oldSide} and ${newSide} differ`;
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
    const contents = created ? newContents : oldContents;
    const lines = contentLines(contents);
    // A marker on every line puts a side that just fits the size ceiling half again over it, and
    // what one file weighs is what a slice's budget is spent in. Such a file is listed without its
    // hunks, the same as one whose sides were too big to read at all.
    //
    // Weighed off the side's own bytes plus the one marker a line will carry, which is strictly
    // under what the section costs and needs none of it built. Joining and measuring half a
    // megabyte of lines to learn an answer already known is 15 to 120ms, and it is spent on
    // exactly the files that hold the request longest.
    if (byteLength(contents) + lines.length > MAX_FILE_BYTES) {
      return { section: `${header}\n`, truncated: true, abandoned: false, edits: lines.length };
    }
    const section = replacementSection(header, input.texts);
    if (byteLength(section) > MAX_FILE_BYTES) {
      return { section: `${header}\n`, truncated: true, abandoned: false, edits: lines.length };
    }
    return { section, truncated: false, abandoned: false, edits: lines.length };
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
  // The bound is reported by giving nothing back. Such a file is listed without its hunks rather
  // than dropped from the change, and rather than written out as wholly replaced: the edit ceiling
  // is a distance rather than a proportion, so a long file can reach it having changed in one
  // corner, and both sides in full would read as a genuine rewrite and bury that corner in a wall
  // of red and green. It spent the whole of what one file is allowed to get here, which is what
  // `edits` carries, so the caller reading a run of files stops rather than paying that again.
  if (patch === undefined) {
    return {
      section: `${header}\n`,
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
  const section = hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.join("\n")}\n`;
  // The edit ceiling bounds how far apart the two sides are, not what the hunks around them
  // weigh: a pair of very long lines is a handful of edits and carries both sides in full, and
  // three lines of context on each side of every hunk pull in more again. So a file well inside
  // the ceiling can still come out heavier than either side was, and what one file weighs is what
  // a slice's budget is spent in. Bounded here the same way the wholly-replaced path above is,
  // and listed without its hunks rather than dropped.
  if (byteLength(section) > MAX_FILE_BYTES) {
    return { section: `${header}\n`, truncated: true, abandoned: false, edits };
  }
  return { section, truncated: false, abandoned: false, edits };
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
