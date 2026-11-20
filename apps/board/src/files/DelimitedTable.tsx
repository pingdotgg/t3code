import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { useMemo } from "react";

/** A TSV or CSV as a table, as T3 parses it. The first row is the header. */
export function DelimitedTable({ text, delimiter }: { text: string; delimiter: "," | "\t" }) {
  const { rows, truncated } = useMemo(
    () => parseDelimitedPreview(text, delimiter),
    [text, delimiter],
  );
  // Cells have no identity beyond their place, so the place is the key.
  const [header = { line: 0, cells: [] }, ...body] = rows.map((cells, line) => ({
    line,
    cells: cells.map((text, column) => ({ column, text })),
  }));
  return (
    <div data-testid="delimited-table" className="min-h-0 flex-1 overflow-auto">
      <table className="min-w-full border-collapse text-left text-[12px]">
        <thead className="sticky top-0 bg-sidebar">
          <tr>
            {header.cells.map((cell) => (
              <th key={cell.column} className="border-b border-line px-3 py-1.5 font-semibold">
                {cell.text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row) => (
            <tr key={row.line} className="odd:bg-hover/40">
              {row.cells.map((cell) => (
                <td key={cell.column} className="max-w-72 truncate px-3 py-1 align-top">
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p role="status" className="px-3 py-2 text-[11px] text-muted">
          Showing the first {rows.length} rows.
        </p>
      )}
    </div>
  );
}
