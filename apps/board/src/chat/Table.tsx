import { type ComponentProps, useRef } from "react";

import { CopyButton } from "./CopyButton";

const rowCells = (row: HTMLTableRowElement) =>
  Array.from(row.cells, (cell) => (cell.textContent ?? "").trim().replaceAll("|", "\\|"));

/** The table's text as a GFM table, which is what pasting it into a message needs. */
function tableAsMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows, rowCells);
  const [header, ...body] = rows;
  if (header === undefined) return "";
  const line = (cells: ReadonlyArray<string>) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}

/** A table that scrolls sideways inside the panel, with a button that copies it as Markdown. */
export function Table(props: ComponentProps<"table">) {
  const table = useRef<HTMLTableElement>(null);
  return (
    <div className="group/table my-2">
      <div className="overflow-x-auto">
        <table ref={table} className="w-full border-collapse text-[12px]" {...props} />
      </div>
      <div className="mt-0.5 flex justify-end opacity-0 transition-opacity group-focus-within/table:opacity-100 group-hover/table:opacity-100">
        <CopyButton
          read={() => (table.current ? tableAsMarkdown(table.current) : "")}
          label="Copy table"
        />
      </div>
    </div>
  );
}
