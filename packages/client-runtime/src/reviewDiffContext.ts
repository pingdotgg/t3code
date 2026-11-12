import { processFile, parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { parseReviewDiffFromFiles } from "./reviewDiffMetadata.ts";
import * as Hash from "effect/Hash";

export const UNKNOWN_REVIEW_LINE = "\u0000unknown:";

/** A staging write changes the comparison, not the code regions the reader opened. */
export function projectReviewDiffContext(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  previous: FileDiffMetadata,
  anchorSide: "additions" | "deletions",
): FileDiffMetadata {
  const generated = parseReviewDiffFromFiles(
    { name: previous.name, contents: before.join("") },
    { name: previous.name, contents: after.join("") },
    { context: Infinity },
  );
  const regions = previous.hunks.map((hunk) => ({
    start: anchorSide === "additions" ? hunk.additionStart : hunk.deletionStart,
    count: anchorSide === "additions" ? hunk.additionCount : hunk.deletionCount,
  }));
  let regionIndex = 0;
  const encode = (sign: string, line: string) =>
    `${sign}${line}${line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
  let oldLine = 1;
  let newLine = 1;
  let oldStart = 1;
  let newStart = 1;
  let oldCount = 0;
  let newCount = 0;
  let body = "";
  const hunks: string[] = [];
  const flush = () => {
    if (!body) return;
    hunks.push(
      `@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@\n${body}`,
    );
    body = "";
    oldCount = newCount = 0;
  };
  const append = (sign: " " | "+" | "-", line: string) => {
    const at = anchorSide === "additions" ? newLine : oldLine;
    while (
      regionIndex < regions.length &&
      at >= regions[regionIndex]!.start + regions[regionIndex]!.count
    )
      regionIndex++;
    const region = regions[regionIndex];
    const keep =
      !line.startsWith(UNKNOWN_REVIEW_LINE) &&
      (sign !== " " || (region !== undefined && at >= region.start));
    if (keep) {
      if (!body) {
        oldStart = oldLine;
        newStart = newLine;
      }
      body += encode(sign, line);
      if (sign !== "+") oldCount++;
      if (sign !== "-") newCount++;
    } else flush();
    if (sign !== "+") oldLine++;
    if (sign !== "-") newLine++;
  };
  if (generated.hunks.length === 0) {
    before.forEach((line) => append(" ", line));
  } else {
    for (const hunk of generated.hunks) {
      for (const content of hunk.hunkContent) {
        if (content.type === "context") {
          generated.additionLines
            .slice(content.additionLineIndex, content.additionLineIndex + content.lines)
            .forEach((line) => append(" ", line));
        } else {
          generated.deletionLines
            .slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions)
            .forEach((line) => append("-", line));
          generated.additionLines
            .slice(content.additionLineIndex, content.additionLineIndex + content.additions)
            .forEach((line) => append("+", line));
        }
      }
    }
  }
  flush();
  const oldPath = JSON.stringify(`a/${previous.name}`);
  const newPath = JSON.stringify(`b/${previous.name}`);
  const header = `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n`;
  let file = parsePatchFiles(header + hunks.join(""))[0]?.files[0];
  if (!file) return { ...previous, hunks: [], splitLineCount: 0, unifiedLineCount: 0 };
  // Full contents let the renderer retain its existing expansion map. The hunks still
  // describe the original open regions, including ones that now contain only context.
  const complete =
    !previous.isPartial &&
    !before.some((line) => line.startsWith(UNKNOWN_REVIEW_LINE)) &&
    !after.some((line) => line.startsWith(UNKNOWN_REVIEW_LINE));
  if (complete) {
    // Complete metadata uses document coordinates, including collapsed gaps and trailing
    // context, for virtualized expansion. Compact offsets are only valid for partial patches.
    file =
      processFile(header + hunks.join(""), {
        oldFile: { name: previous.name, contents: before.join("") },
        newFile: { name: previous.name, contents: after.join("") },
        throwOnError: true,
      }) ?? file;
  } else {
    let splitStart = 0;
    let unifiedStart = 0;
    file.hunks = file.hunks.map((hunk) => {
      const next = { ...hunk, splitLineStart: splitStart, unifiedLineStart: unifiedStart };
      splitStart += hunk.splitLineCount;
      unifiedStart += hunk.unifiedLineCount;
      return next;
    });
    file.splitLineCount = splitStart;
    file.unifiedLineCount = unifiedStart;
  }
  return {
    ...file,
    type: previous.type,
    ...(previous.prevName ? { prevName: previous.prevName } : {}),
    ...(previous.lang ? { lang: previous.lang } : {}),
    cacheKey: `working-context:${Hash.string(header + hunks.join(""))}:${complete}`,
  };
}

/** Compare actual edits independently of Git's hunk/context regrouping. */
export function reviewDiffEdits(file: FileDiffMetadata): string {
  const lineText = (line: string, at: number, last: number, noEOF: boolean) =>
    noEOF && at === last ? line.replace(/\n$/, "") : line.endsWith("\n") ? line : `${line}\n`;
  return JSON.stringify(
    file.hunks.flatMap((hunk) =>
      hunk.hunkContent.flatMap((content) => {
        if (content.type !== "change") return [];
        return [
          ...file.deletionLines
            .slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions)
            .map((line, index) => [
              "-",
              hunk.deletionStart + content.deletionLineIndex - hunk.deletionLineIndex + index,
              lineText(
                line,
                content.deletionLineIndex + index,
                hunk.deletionLineIndex + hunk.deletionCount - 1,
                hunk.noEOFCRDeletions,
              ),
            ]),
          ...file.additionLines
            .slice(content.additionLineIndex, content.additionLineIndex + content.additions)
            .map((line, index) => [
              "+",
              hunk.additionStart + content.additionLineIndex - hunk.additionLineIndex + index,
              lineText(
                line,
                content.additionLineIndex + index,
                hunk.additionLineIndex + hunk.additionCount - 1,
                hunk.noEOFCRAdditions,
              ),
            ]),
        ];
      }),
    ),
  );
}
