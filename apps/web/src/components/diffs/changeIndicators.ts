import type { FileDiffMetadata } from "@pierre/diffs";

// Deletions use the gap after start (0 is before the first line); additions use line numbers.
export interface ChangeRange {
  readonly kind: "addition" | "deletion";
  readonly start: number;
  readonly end: number;
}

export function fileChangeRanges(file: FileDiffMetadata): ChangeRange[] {
  const ranges: ChangeRange[] = [];
  const lineCount = Math.max(1, file.additionLines.length);
  for (const hunk of file.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== "change") continue;
      const start = hunk.additionStart + content.additionLineIndex - hunk.additionLineIndex;
      if (content.additions > 0) {
        ranges.push({ kind: "addition", start, end: start + content.additions - 1 });
      }
      if (content.deletions > 0 && content.additions === 0) {
        const anchor = Math.max(0, Math.min(lineCount, start - 1));
        ranges.push({ kind: "deletion", start: anchor, end: anchor });
      }
    }
  }
  return ranges;
}

export function paintFileChanges(root: ShadowRoot, ranges: readonly ChangeRange[]): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-column-number]")) {
    const line = Number(node.getAttribute("data-column-number"));
    const addition = ranges.some(
      (range) => range.kind === "addition" && line >= range.start && line <= range.end,
    );
    const deletion = ranges.find(
      (range) => range.kind === "deletion" && line === Math.max(1, range.start),
    );
    node.toggleAttribute("data-file-addition", addition);
    if (deletion) {
      node.setAttribute("data-file-deletion", deletion.start === 0 ? "before" : "after");
    } else {
      node.removeAttribute("data-file-deletion");
    }
  }
}
