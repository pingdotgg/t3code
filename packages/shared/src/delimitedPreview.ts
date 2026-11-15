import { GENERIC_MIME_TYPES } from "./image.ts";

export function filePreviewDelimiter(file: { name: string; mimeType?: string }): "," | "\t" | null {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "text/csv") return ",";
  if (mime === "text/tab-separated-values") return "\t";
  if (mime && mime !== "text/plain" && !GENERIC_MIME_TYPES.has(mime)) return null;
  if (/\.csv$/i.test(file.name)) return ",";
  if (/\.tsv$/i.test(file.name)) return "\t";
  return null;
}

export function parseDelimitedPreview(
  text: string,
  delimiter: "," | ";" | "\t",
  limits: { maxRows: number; maxColumns: number; maxCellLength: number; detectCsv?: boolean } = {
    maxRows: 100,
    maxColumns: 30,
    maxCellLength: 2000,
  },
) {
  if (delimiter === "," && limits.detectCsv !== false) {
    delimiter = csvPreviewDelimiter(text);
  }
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

export function csvPreviewDelimiter(text: string) {
  // Semicolons win only when they are consistent across the first two records and commas are not.
  const commas = [0, 0];
  const semicolons = [0, 0];
  let record = 0;
  let second = false;
  let quoted = false;
  let fieldStart = true;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') continue;
      if (text[index + 1] === '"') index++;
      else quoted = false;
    } else if (char === '"' && fieldStart) quoted = true;
    else if (char === "\n" || char === "\r") {
      if (record === 1) break;
      if (char === "\r" && text[index + 1] === "\n") index++;
      record = 1;
      fieldStart = true;
      continue;
    } else if (char === ",") commas[record]!++;
    else if (char === ";") semicolons[record]!++;
    second ||= record === 1;
    fieldStart = char === "," || char === ";";
  }
  if (semicolons[0]! <= commas[0]!) return ",";
  if (!second) return ";";
  const consistentCommas = commas[0]! > 0 && commas[1] === commas[0];
  return semicolons[1] === semicolons[0] && !consistentCommas ? ";" : ",";
}
