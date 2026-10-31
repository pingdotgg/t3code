import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { structuredPatch } from "diff";

import type { AzureDevOpsChangeEntry, AzureDevOpsDiffBlock } from "./azureDevOpsPullRequestJson.ts";

/**
 * Pin the iteration to prevent pushes from renumbering files during pagination. The two sources
 * list files in different orders, so a position only holds for the source that wrote it.
 */
export interface AzureDevOpsDiffCursor {
  readonly iterationId: number;
  readonly fileIndex: number;
  readonly source: "changes" | "filesdiff";
}

const CURSOR_SEPARATOR = ":";

const CURSOR_COMPONENT = /^\d+$/;

const FILES_DIFF_MARKER = "d";

export function formatAzureDevOpsDiffCursor(cursor: AzureDevOpsDiffCursor): string {
  const position = `${cursor.iterationId}${CURSOR_SEPARATOR}${cursor.fileIndex}`;
  return cursor.source === "filesdiff"
    ? `${position}${CURSOR_SEPARATOR}${FILES_DIFF_MARKER}`
    : position;
}

export function parseAzureDevOpsDiffCursor(
  raw: string | null | undefined,
): AzureDevOpsDiffCursor | null {
  if (raw === null || raw === undefined) return null;
  const [iteration, file, marker, ...rest] = raw.split(CURSOR_SEPARATOR);
  if (rest.length > 0) return null;
  if (marker !== undefined && marker !== FILES_DIFF_MARKER) return null;
  if (iteration === undefined || file === undefined) return null;
  if (!CURSOR_COMPONENT.test(iteration) || !CURSOR_COMPONENT.test(file)) return null;
  const iterationId = Number(iteration);
  const fileIndex = Number(file);
  if (!Number.isSafeInteger(iterationId) || iterationId <= 0) return null;
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return null;
  return { iterationId, fileIndex, source: marker === undefined ? "changes" : "filesdiff" };
}

export interface AzureDevOpsFileTexts {
  readonly oldContents: string;
  readonly newContents: string;
  readonly binary: boolean;
}

export interface AzureDevOpsFilePatch {
  readonly section: string;
  readonly truncated: boolean;
  readonly abandoned: boolean;
  readonly edits: number;
}

/** Azure returns whole files; oversized files incur both reads before diffing. */
const MAX_FILE_BYTES = 512 * 1024;

const PATCH_CONTEXT_LINES = 3;

/** Edit distance bounds quadratic work independently of machine speed. */
export const MAX_FILE_DIFF_EDITS = 2_000;

const MAX_FILE_DIFF_MILLIS = 2_000;

export const MAX_DIFF_SLICE_EDITS = 6_000;

export const MAX_DIFF_SLICE_BYTES = 256 * 1024;

/** Header-only entries can evade the byte and edit budgets. */
export const MAX_DIFF_SLICE_FILES = 300;

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function contentLines(contents: string): ReadonlyArray<string> {
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isBinary(contents: string): boolean {
  return contents.includes("\u0000");
}

export const byteLength = (contents: string) => Buffer.byteLength(contents, "utf8");

/** Git anchors empty ranges at the preceding line, which may be zero. */
function hunkRange(start: number, lines: number): string {
  if (lines === 0) return `${start - 1},0`;
  return lines === 1 ? String(start) : `${start},${lines}`;
}

/** Azure omits modes. Quote prefixed paths to preserve tabs/newlines. */
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

export function azureDevOpsFilePatch(input: {
  readonly change: AzureDevOpsChangeEntry;
  readonly texts: AzureDevOpsFileTexts;
}): AzureDevOpsFilePatch {
  const header = patchHeader(input.change);
  const { oldContents, newContents } = input.texts;

  if (input.texts.binary || isBinary(oldContents) || isBinary(newContents)) {
    const oldSide = quoteGitPatchPath(`a/${input.change.oldPath}`);
    const newSide = quoteGitPatchPath(`b/${input.change.path}`);
    const binary = `Binary files ${oldSide} and ${newSide} differ`;
    return { section: `${header}\n${binary}\n`, truncated: true, abandoned: false, edits: 0 };
  }
  if (byteLength(oldContents) > MAX_FILE_BYTES || byteLength(newContents) > MAX_FILE_BYTES) {
    return { section: `${header}\n`, truncated: true, abandoned: false, edits: 0 };
  }

  const created = oldContents === "" && newContents !== "";
  const deleted = newContents === "" && oldContents !== "";
  if (created || deleted) {
    const contents = created ? newContents : oldContents;
    const lines = contentLines(contents);
    // Include per-line markers in the byte budget.
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
  // A full replacement could bury a small change that hit the edit limit.
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
  const section = hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.join("\n")}\n`;
  // Long lines can exceed the byte budget even within the edit budget.
  if (byteLength(section) > MAX_FILE_BYTES) {
    return { section: `${header}\n`, truncated: true, abandoned: false, edits };
  }
  return { section, truncated: false, abandoned: false, edits };
}

export function azureDevOpsUnreadableFilePatch(
  change: AzureDevOpsChangeEntry,
): AzureDevOpsFilePatch {
  return { section: `${patchHeader(change)}\n`, truncated: true, abandoned: false, edits: 0 };
}

/** Stands for a line Azure left out, so the lines after it keep their numbers. */
const ELIDED_LINE = "\u0001";

/** Prefixes the lines Azure changed on each side, so a diff cannot match them to each other. */
const OLD_CHANGED = "\u0002";
const NEW_CHANGED = "\u0003";
const TAGS = [ELIDED_LINE, OLD_CHANGED, NEW_CHANGED];

/** A window shows equal lines on both sides, maybe fewer than it counts; a change shows all it counts. */
function isCoherentBlock(block: AzureDevOpsDiffBlock): boolean {
  if (block.kind === "none") {
    return (
      block.oldLines.length === block.newLines.length && block.oldLines.length <= block.oldCount
    );
  }
  return block.oldLines.length === block.oldCount && block.newLines.length === block.newCount;
}

/**
 * Both sides of a file as far as the blocks tell it: the changed lines, the unchanged lines Azure
 * shows around them, and ELIDED_LINE for everything it left out. Null when the blocks do not add
 * up to a file.
 */
function rebuildSides(
  blocks: ReadonlyArray<AzureDevOpsDiffBlock>,
): { readonly oldLines: string[]; readonly newLines: string[] } | null {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const place = (side: string[], start: number, lines: ReadonlyArray<string>, tag: string) => {
    if (lines.length === 0) return true;
    // A file with more lines than bytes it may have is too long to rebuild.
    if (start <= side.length || start > MAX_FILE_BYTES) return false;
    // A line holding a tag could be taken for one.
    if (lines.some((line) => TAGS.some((reserved) => line.includes(reserved)))) return false;
    while (side.length + 1 < start) side.push(ELIDED_LINE);
    for (const line of lines) side.push(tag + line);
    return true;
  };

  // The lines Azure counts after the last it shows on a side, because it shows only a window.
  let oldHidden = 0;
  let newHidden = 0;
  for (const block of blocks) {
    if (!isCoherentBlock(block)) return null;
    const window = block.kind === "none";
    // Lines Azure matched stand for both sides, whatever their indentation.
    const oldShown = window ? block.newLines : block.oldLines;
    if (!place(oldLines, block.oldStart, oldShown, window ? "" : OLD_CHANGED)) return null;
    if (!place(newLines, block.newStart, block.newLines, window ? "" : NEW_CHANGED)) return null;
    if (oldShown.length > 0) oldHidden = block.oldCount - block.oldLines.length;
    if (block.newLines.length > 0) newHidden = block.newCount - block.newLines.length;
  }

  // Azure splits on "\n", so a file ending in a newline ends in one more, empty, line.
  // That line is the end of the file, not a changed line.
  if (oldLines.at(-1) === OLD_CHANGED) oldLines[oldLines.length - 1] = "";
  if (newLines.at(-1) === NEW_CHANGED) newLines[newLines.length - 1] = "";
  // Tails of unlike lengths hide a change in how the file ends, which no line shows.
  if (oldHidden !== newHidden && Math.min(oldHidden, newHidden) > 1) return null;
  // One hidden line is the empty one after a final newline; more is text Azure left out.
  for (const [side, hidden] of [
    [oldLines, oldHidden],
    [newLines, newHidden],
  ] as const) {
    if (hidden > 1) side.push(ELIDED_LINE);
    if (hidden > 0) side.push("");
  }
  return { oldLines, newLines };
}

/**
 * The patch from Azure's diff blocks, or null when they cannot stand for the file. Both sides
 * are rebuilt and diffed as whole files, with the changed lines tagged to keep Azure's alignment.
 * Azure ignores indentation, so an indentation-only edit never arrives, as on its own page.
 */
export function azureDevOpsFileDiffPatch(input: {
  readonly change: AzureDevOpsChangeEntry;
  readonly blocks: ReadonlyArray<AzureDevOpsDiffBlock> | null;
}): AzureDevOpsFilePatch | null {
  const { change, blocks } = input;
  const sides = blocks === null ? null : rebuildSides(blocks);
  if (sides === null) return null;

  const patch = azureDevOpsFilePatch({
    change,
    texts: {
      oldContents: sides.oldLines.join("\n"),
      newContents: sides.newLines.join("\n"),
      binary: false,
    },
  });
  // A hunk that reaches text Azure left out cannot be trusted.
  if (patch.section.includes(ELIDED_LINE)) return null;
  // No blocks is a binary or empty file, which only a read can tell from a move.
  if (patch.edits === 0 && !patch.truncated && change.changeKind !== "rename-pure") return null;
  return {
    ...patch,
    section: patch.section.replaceAll(OLD_CHANGED, "").replaceAll(NEW_CHANGED, ""),
  };
}
