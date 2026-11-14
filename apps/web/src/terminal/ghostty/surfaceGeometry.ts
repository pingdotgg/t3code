import { SELECTION_MULTI_CLICK_INTERVAL_MS } from "../../lib/selectionActions";
import {
  GHOSTTY_CELL_WIDE,
  type GhosttyCell,
  type GhosttyScrollbar,
  type GhosttySnapshot,
} from "./core";
import { GhosttyCellMetrics, GhosttyCellRange } from "./renderer";

export const CONTENT_PADDING = 4;
export const MIN_SCROLLBAR_THUMB_HEIGHT = 18;

export function terminalContentOriginY(
  mountHeight: number,
  padding: number,
  rows: number,
  cellHeight: number,
  anchorBottom: boolean,
): number {
  if (!anchorBottom) return padding;
  const slack = mountHeight - padding * 2 - rows * cellHeight;
  return padding + Math.max(0, slack);
}

export interface TerminalScrollbarGeometry {
  readonly thumbHeight: number;
  readonly thumbTop: number;
  readonly maxOffset: number;
}

export function terminalScrollbarGeometry(
  state: GhosttyScrollbar,
  trackHeight: number,
): TerminalScrollbarGeometry | null {
  const total = Math.max(0, state.total);
  const len = Math.max(0, Math.min(state.len, total));
  const maxOffset = Math.max(0, total - len);
  if (trackHeight <= 0 || len <= 0 || maxOffset === 0) return null;
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, (trackHeight * len) / total),
  );
  const travel = Math.max(0, trackHeight - thumbHeight);
  const offset = Math.max(0, Math.min(state.offset, maxOffset));
  return {
    thumbHeight,
    thumbTop: travel * (offset / maxOffset),
    maxOffset,
  };
}

export function terminalScrollbarOffsetAtPointer(
  state: GhosttyScrollbar,
  trackHeight: number,
  pointerY: number,
  pointerOffset: number,
): number {
  const geometry = terminalScrollbarGeometry(state, trackHeight);
  if (geometry === null) return 0;
  const travel = Math.max(0, trackHeight - geometry.thumbHeight);
  if (travel === 0) return 0;
  const thumbTop = Math.max(0, Math.min(pointerY - pointerOffset, travel));
  return Math.round((thumbTop / travel) * geometry.maxOffset);
}

export function terminalGridCellAt(options: {
  bounds: { left: number; top: number };
  clientX: number;
  clientY: number;
  cols: number;
  rows: number;
  metrics: Pick<GhosttyCellMetrics, "width" | "height">;
  padding: number;
  originY: number;
}): { x: number; y: number } | null {
  const { bounds, clientX, clientY, cols, rows, metrics, padding, originY } = options;
  const gridX = clientX - bounds.left - padding;
  const gridY = clientY - bounds.top - originY;
  if (gridX < 0 || gridY < 0 || gridX >= cols * metrics.width || gridY >= rows * metrics.height) {
    return null;
  }
  return {
    x: Math.floor(gridX / metrics.width),
    y: Math.floor(gridY / metrics.height),
  };
}

export function terminalCellText(cell: GhosttyCell): string {
  if (cell.wide === GHOSTTY_CELL_WIDE.spacerTail || cell.wide === GHOSTTY_CELL_WIDE.spacerHead) {
    return "";
  }
  return cell.text || " ";
}

export function terminalRowText(
  row: GhosttySnapshot["rowData"][number],
  trimRight: boolean,
): string {
  const text = row.cells.map(terminalCellText).join("");
  return trimRight ? text.trimEnd() : text;
}

export function terminalColumnOffset(
  row: GhosttySnapshot["rowData"][number],
  column: number,
): number {
  let offset = 0;
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    const cell = row.cells[cellIndex];
    offset += cell ? terminalCellText(cell).length : 1;
  }
  return offset;
}

export interface TerminalLinkWithRange {
  readonly text: string;
  readonly range: GhosttyCellRange;
}

export function isSameTerminalLink(
  left: TerminalLinkWithRange,
  right: TerminalLinkWithRange | null,
): boolean {
  return (
    right?.text === left.text &&
    right.range.start.x === left.range.start.x &&
    right.range.start.y === left.range.start.y &&
    right.range.end.x === left.range.end.x &&
    right.range.end.y === left.range.end.y
  );
}

export function terminalColumnAtOffset(
  row: GhosttySnapshot["rowData"][number],
  offset: number,
): number {
  for (let column = 0; column < row.cells.length; column += 1) {
    const nextOffset = terminalColumnOffset(row, column + 1);
    if (offset < nextOffset) return column;
  }
  return Math.max(0, row.cells.length - 1);
}

export interface TerminalSelectionClickSequence {
  readonly count: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export const TERMINAL_LINK_DRAG_THRESHOLD_PX = 4;

export function advanceTerminalSelectionClickSequence(
  previous: TerminalSelectionClickSequence | null,
  event: Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">,
): TerminalSelectionClickSequence {
  const repeats =
    previous !== null &&
    event.timeStamp - previous.time <= SELECTION_MULTI_CLICK_INTERVAL_MS &&
    Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <=
      TERMINAL_LINK_DRAG_THRESHOLD_PX;
  return {
    count: repeats ? (previous.count >= 3 ? 1 : previous.count + 1) : 1,
    time: event.timeStamp,
    x: event.clientX,
    y: event.clientY,
  };
}
