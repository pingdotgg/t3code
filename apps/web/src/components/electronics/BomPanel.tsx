import type { ElectronicsBomEntry } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { Input } from "../ui/input";

export interface BomPanelProps {
  readonly bom: ReadonlyArray<ElectronicsBomEntry>;
  readonly onSelectRef: (ref: string) => void;
}

export function BomPanel(props: BomPanelProps) {
  const { bom, onSelectRef } = props;
  const gt = useGT();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q
    ? bom.filter(
        (row) =>
          row.value.toLowerCase().includes(q) ||
          row.kind.toLowerCase().includes(q) ||
          (row.footprint?.toLowerCase().includes(q) ?? false) ||
          row.refs.some((r) => r.toLowerCase().includes(q)),
      )
    : bom;

  const totalParts = filtered.reduce((acc, row) => acc + row.quantity, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex max-w-xs flex-1 items-center gap-1.5">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={gt("Filter BOM by ref, value, footprint…")}
          />
        </div>
        <span className="font-mono text-2xs text-muted-foreground">
          {gt("{lines} lines · {parts} parts", { lines: filtered.length, parts: totalParts })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-border/70 bg-card/40 p-4 text-center text-muted-foreground">
          <T>No BOM entries found.</T>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-left text-2xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">
                  <T>Designators</T>
                </th>
                <th className="px-2.5 py-1.5 font-medium">
                  <T>Value</T>
                </th>
                <th className="px-2.5 py-1.5 font-medium">
                  <T>Footprint</T>
                </th>
                <th className="px-2.5 py-1.5 text-right font-medium">
                  <T>Qty</T>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filtered.map((row) => (
                <tr
                  key={`${row.value}:${row.footprint ?? ""}:${row.refs.join(",")}`}
                  className="hover:bg-muted/30"
                >
                  <td className="px-2.5 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {row.refs.map((ref) => (
                        <button
                          key={ref}
                          type="button"
                          onClick={() => onSelectRef(ref)}
                          className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-3xs font-medium text-primary hover:bg-primary/20"
                        >
                          {ref}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-foreground">{row.value}</td>
                  <td className="px-2.5 py-1.5 font-mono text-muted-foreground">
                    {row.footprint ?? "-"}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono font-semibold">
                    {row.quantity}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
