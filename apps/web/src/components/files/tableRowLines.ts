// Table cells wrap (`whitespace-pre-wrap`), but only the columns in view are mounted. A row's
// natural height therefore changes as you scroll sideways. Estimate the tallest wrap across every
// column so the row can hold one height. The character width is deliberately a little narrow, so a
// row may be a touch too short (never blank) and fall back to its natural height.
const CELL_CHROME_PX = 25; // px-3 on both sides plus the 1px column border
const CHAR_PX = 6;

export function estimateRowLines(row: readonly string[] | undefined, widths: readonly number[]) {
  if (!row) return 1;
  let lines = 1;
  for (let column = 0; column < row.length; column += 1) {
    const cell = row[column];
    if (!cell || (cell.length < 8 && !cell.includes("\n"))) continue;
    const perLine = Math.max(1, Math.floor(((widths[column] ?? 0) - CELL_CHROME_PX) / CHAR_PX));
    let cellLines = 0;
    for (const part of cell.split("\n")) cellLines += Math.max(1, Math.ceil(part.length / perLine));
    if (cellLines > lines) lines = cellLines;
  }
  return lines;
}

/** Text-xs rows: 16px per line plus py-1.5 padding and the bottom border (29px for one line). */
export const tableRowMinHeight = (lines: number) => 13 + 16 * lines;
