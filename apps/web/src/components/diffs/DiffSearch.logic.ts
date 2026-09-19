import type { CodeViewItem, SelectionSide } from "@pierre/diffs";

export function isDiffSearchShortcut(event: KeyboardEvent) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key.toLowerCase() === "f" || event.key.toLowerCase() === "d") &&
    event
      .composedPath()
      .some((node) => node instanceof HTMLElement && node.hasAttribute("data-diff-search-scope"))
  );
}

export interface DiffSearchMatch {
  id: string;
  lineNumber: number;
  side: SelectionSide;
  character: number;
  length: number;
}

const MAX_SEARCH_MATCHES = 10_000;

export function findDiffSearchMatches<LAnnotation>(
  items: readonly CodeViewItem<LAnnotation>[],
  query: string,
): { matches: DiffSearchMatch[]; limited: boolean } {
  if (!query) return { matches: [], limited: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: DiffSearchMatch[] = [];
  for (const item of items) {
    const search = (text: string, lineNumber: number, side: SelectionSide) => {
      for (const match of text.matchAll(pattern)) {
        if (matches.length === MAX_SEARCH_MATCHES) return true;
        matches.push({
          id: item.id,
          lineNumber,
          side,
          character: match.index,
          length: match[0].length,
        });
      }
      return false;
    };
    if (item.type === "file") {
      let lineNumber = 0;
      for (const line of item.file.contents.matchAll(/[^\n]*(?:\n|$)/g)) {
        if (search(line[0], ++lineNumber, "additions")) return { matches, limited: true };
      }
      continue;
    }
    const diff = item.fileDiff;
    let nextAddition = 0;
    for (const hunk of diff.hunks) {
      if (!diff.isPartial) {
        while (nextAddition < hunk.additionLineIndex) {
          if (search(diff.additionLines[nextAddition]!, nextAddition + 1, "additions"))
            return { matches, limited: true };
          nextAddition++;
        }
      }
      for (const content of hunk.hunkContent) {
        if (content.type === "change") {
          for (let index = 0; index < content.deletions; index++) {
            const lineIndex = content.deletionLineIndex + index;
            if (
              search(
                diff.deletionLines[lineIndex]!,
                hunk.deletionStart + lineIndex - hunk.deletionLineIndex,
                "deletions",
              )
            )
              return { matches, limited: true };
          }
        }
        const count = content.type === "context" ? content.lines : content.additions;
        for (let index = 0; index < count; index++) {
          const lineIndex = content.additionLineIndex + index;
          if (
            search(
              diff.additionLines[lineIndex]!,
              hunk.additionStart + lineIndex - hunk.additionLineIndex,
              "additions",
            )
          )
            return { matches, limited: true };
        }
      }
      nextAddition = Math.max(0, hunk.additionLineIndex + hunk.additionCount);
    }
    if (!diff.isPartial) {
      while (nextAddition < diff.additionLines.length) {
        if (search(diff.additionLines[nextAddition]!, nextAddition + 1, "additions"))
          return { matches, limited: true };
        nextAddition++;
      }
    }
  }
  return { matches, limited: false };
}

export function revealDiffSearchMatch<LAnnotation>(
  items: readonly CodeViewItem<LAnnotation>[],
  match: DiffSearchMatch | undefined,
): readonly CodeViewItem<LAnnotation>[] {
  if (!match) return items;
  return items.map((item) =>
    item.id === match.id && item.collapsed ? { ...item, collapsed: false } : item,
  );
}
