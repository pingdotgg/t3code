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
    const format = csvPreviewFormat(text);
    delimiter = format.delimiter;
    text = text.slice(format.offset);
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

export function csvPreviewFormat(text: string) {
  const directive = /^\ufeff?sep=([,;\t])(?:\r\n|\n|\r|$)/i.exec(text);
  if (directive) {
    return { delimiter: directive[1] as "," | ";" | "\t", offset: directive[0].length };
  }
  let commas = 0;
  let semicolons = 0;
  for (const match of text.matchAll(/"(?:[^"]|"")*"|([,;\r\n])/g)) {
    const separator = match[1];
    if (separator === "\r" || separator === "\n") break;
    if (separator === ",") commas++;
    if (separator === ";") semicolons++;
  }
  return { delimiter: semicolons > commas ? (";" as const) : ("," as const), offset: 0 };
}
