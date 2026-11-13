import { isMacPlatform } from "../../lib/utils";
import { SELECTION_MULTI_CLICK_INTERVAL_MS } from "../../lib/selectionActions";
import { collectWrappedTerminalLinkLine, extractTerminalLinks } from "../../terminal-links";
import {
  GHOSTTY_CELL_WIDE,
  GhosttyTerminalCore,
  type GhosttyCell,
  type GhosttyScrollbar,
  type GhosttySnapshot,
  type GhosttyTheme,
} from "./core";
import {
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
  type GhosttyCellRange,
  type GhosttyCellMetrics,
} from "./renderer";
import symbolsFontUrl from "./fonts/SymbolsNerdFontMono-Regular.woff2?url";
import { isMonospaceFamily } from "../../appearanceFonts";
import { observeResize } from "../../lib/observeResize";
import type { TerminalLinkWithRange } from "./surface";
import { terminalColumnAtOffset, terminalColumnOffset, terminalRowText } from "./surface";

export function terminalLinkAtPositionWithRange(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
): TerminalLinkWithRange | null {
  const wrappedLine = collectWrappedTerminalLinkLine(rowIndex + 1, (index) => {
    const row = rows[index];
    if (!row) return null;
    return {
      isWrapped: row.isWrapContinuation,
      translateToString: (trimRight = false) => terminalRowText(row, trimRight),
    };
  });
  if (!wrappedLine) return null;
  // A wrapped line starting above the viewport would produce a truncated, incorrect link.
  const firstSegment = wrappedLine.segments[0];
  if (firstSegment && rows[firstSegment.bufferLineNumber - 1]?.isWrapContinuation) {
    return null;
  }
  const segment = wrappedLine.segments.find((value) => value.bufferLineNumber === rowIndex + 1);
  const row = rows[rowIndex];
  if (!segment || !row) return null;
  const lastSegment = wrappedLine.segments.at(-1);
  const lastRow = lastSegment ? rows[lastSegment.bufferLineNumber - 1] : undefined;
  const continuesBelowViewport = lastRow !== undefined && lastRow.wrapsToNext;
  const hitColumn = row.cells[column]?.wide === GHOSTTY_CELL_WIDE.spacerTail ? column - 1 : column;
  const offset = segment.startIndex + terminalColumnOffset(row, hitColumn);
  for (const match of extractTerminalLinks(wrappedLine.text)) {
    if (offset >= match.start && offset < match.end) {
      if (match.end === wrappedLine.text.length && continuesBelowViewport) return null;
      const startSegment = wrappedLine.segments.find(
        (value) => match.start >= value.startIndex && match.start < value.endIndex,
      );
      const endSegment = wrappedLine.segments.find(
        (value) => match.end - 1 >= value.startIndex && match.end - 1 < value.endIndex,
      );
      const startRow = startSegment ? rows[startSegment.bufferLineNumber - 1] : undefined;
      const endRow = endSegment ? rows[endSegment.bufferLineNumber - 1] : undefined;
      if (!startSegment || !endSegment || !startRow || !endRow) return null;
      const endColumn = terminalColumnAtOffset(endRow, match.end - 1 - endSegment.startIndex);
      return {
        text: match.text,
        range: {
          start: {
            x: terminalColumnAtOffset(startRow, match.start - startSegment.startIndex),
            y: startSegment.bufferLineNumber - 1,
          },
          end: {
            x:
              endRow.cells[endColumn + 1]?.wide === GHOSTTY_CELL_WIDE.spacerTail
                ? endColumn + 1
                : endColumn,
            y: endSegment.bufferLineNumber - 1,
          },
        },
      };
    }
  }
  return null;
}

