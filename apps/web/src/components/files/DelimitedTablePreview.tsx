/* oxlint-disable react/no-array-index-key -- Table rows and columns have stable positions and may contain identical values. */
import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { useMemo } from "react";

import { FileSurfaceNotice } from "./fileSurfaceChrome";

/** A bounded, readable table for CSV and TSV text; the source view keeps every byte. */
export function DelimitedTablePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly delimiter: "," | "\t";
}) {
  const table = useMemo(
    () => parseDelimitedPreview(props.text, props.delimiter),
    [props.text, props.delimiter],
  );
  const [header, ...body] = table.rows;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {table.truncated ? (
        <FileSurfaceNotice>
          Table limited to the first 100 rows and 30 columns. Switch to source for the rest.
        </FileSurfaceNotice>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="min-w-full border-separate border-spacing-0 text-xs"
          aria-label={props.name}
        >
          {header ? (
            <thead className="sticky top-0 z-10">
              <tr>
                {header.map((cell, columnIndex) => (
                  <th
                    key={columnIndex}
                    scope="col"
                    className="max-w-80 border-b border-border bg-muted/60 px-3 py-1.5 text-left align-bottom font-medium whitespace-pre-wrap break-words backdrop-blur"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="even:bg-muted/30">
                {row.map((cell, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
