export function filePreviewDelimiter(file: { name: string; mimeType?: string }): "," | "\t" | null {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "text/csv") return ",";
  if (mime === "text/tab-separated-values") return "\t";
  if (mime && mime !== "text/plain" && mime !== "application/octet-stream") return null;
  if (/\.csv$/i.test(file.name)) return ",";
  if (/\.tsv$/i.test(file.name)) return "\t";
  return null;
}

export function parseDelimitedPreview(
  text: string,
  delimiter: "," | "\t",
  limits: { maxRows: number; maxColumns: number; maxCellLength: number } = {
    maxRows: 100,
    maxColumns: 30,
    maxCellLength: 2000,
  },
) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  let rowStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    if (cell.length > limits.maxCellLength) {
      let end = limits.maxCellLength;
      const before = cell.charCodeAt(end - 1);
      const after = cell.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
      cell = cell.slice(0, end);
      truncated = true;
    }
    if (row.length < limits.maxColumns) row.push(cell);
    else truncated = true;
    cell = "";
  };
  for (let index = rowStart; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        if (cell.length <= limits.maxCellLength) cell += '"';
        else truncated = true;
        index++;
        continue;
      }
      if (quoted || cell === "") {
        quoted = !quoted;
        continue;
      }
    }
    if (!quoted && (char === delimiter || char === "\n" || char === "\r")) {
      endCell();
      if (char !== delimiter) {
        rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
        rowStart = index + 1;
        if (rows.length === limits.maxRows)
          return { rows, truncated: truncated || index < text.length - 1 };
      }
    } else if (cell.length <= limits.maxCellLength) cell += char;
    else truncated = true;
  }
  if (rowStart < text.length) {
    endCell();
    rows.push(row);
  }
  return { rows, truncated: truncated || quoted };
}

export type DelimitedColumnKind = "number" | "date" | "text";

const NUMERIC_CELL = /^[-+]?[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?%?$/;
const DATE_CELL =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function delimitedCellKind(cell: string): DelimitedColumnKind {
  if (/\d/.test(cell) && NUMERIC_CELL.test(cell)) return "number";
  return DATE_CELL.test(cell) ? "date" : "text";
}

/**
 * Classifies each column from its body cells (the header row excluded) so the
 * table can set numbers and dates in mono and right-align numbers. Blank cells
 * do not count, and a column with no filled cells stays text.
 */
export function delimitedColumnKinds(
  bodyRows: ReadonlyArray<ReadonlyArray<string>>,
  columnCount: number,
): DelimitedColumnKind[] {
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    let kind: DelimitedColumnKind | null = null;
    for (const row of bodyRows) {
      const cell = row[columnIndex]?.trim() ?? "";
      if (cell === "") continue;
      const cellKind = delimitedCellKind(cell);
      if (cellKind === "text" || (kind !== null && kind !== cellKind)) return "text";
      kind = cellKind;
    }
    return kind ?? "text";
  });
}
