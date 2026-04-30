import { useCallback, useRef, useState } from "react";
import { Grid2X2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

import { GRID_MAX_DIM, GRID_MIN_DIM } from "./gridLayout";

interface GridSizePickerProps {
  currentRows: number;
  currentCols: number;
  onSelect: (rows: number, cols: number) => void;
  triggerLabel?: string;
  className?: string;
  align?: "start" | "center" | "end";
}

/**
 * Google Docs-style 6x6 hover picker. Hovering the dots selects the preview
 * rows/cols; clicking confirms.
 */
export function GridSizePicker({
  currentRows,
  currentCols,
  onSelect,
  triggerLabel,
  className,
  align = "start",
}: GridSizePickerProps) {
  const [open, setOpen] = useState(false);
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const previewRows = hoveredRow !== null ? hoveredRow + 1 : currentRows;
  const previewCols = hoveredCol !== null ? hoveredCol + 1 : currentCols;

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setHoveredRow(null);
      setHoveredCol(null);
    }
  }, []);

  const handleSelect = useCallback(
    (row: number, col: number) => {
      onSelect(row + 1, col + 1);
      setOpen(false);
      setHoveredRow(null);
      setHoveredCol(null);
    },
    [onSelect],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            className={cn("gap-1.5", className)}
            aria-label="Pick grid dimensions"
          >
            <Grid2X2Icon className="size-3" />
            <span className="tabular-nums">
              {currentRows}×{currentCols}
            </span>
            {triggerLabel ? (
              <span className="ml-1 text-muted-foreground">{triggerLabel}</span>
            ) : null}
          </Button>
        }
      />
      <PopoverPopup align={align} sideOffset={4} className="w-auto">
        <div className="flex flex-col gap-2" data-grid-size-picker-root>
          <div className="text-center text-[11px] font-medium tabular-nums text-muted-foreground">
            {previewRows} × {previewCols}
          </div>
          <div
            ref={gridRef}
            className="grid select-none gap-1"
            style={{
              gridTemplateColumns: `repeat(${GRID_MAX_DIM}, 1rem)`,
              gridTemplateRows: `repeat(${GRID_MAX_DIM}, 1rem)`,
            }}
            onMouseLeave={() => {
              setHoveredRow(null);
              setHoveredCol(null);
            }}
          >
            {Array.from({ length: GRID_MAX_DIM * GRID_MAX_DIM }, (_, index) => {
              const row = Math.floor(index / GRID_MAX_DIM);
              const col = index - row * GRID_MAX_DIM;
              const rowsToHighlight = hoveredRow ?? currentRows - 1;
              const colsToHighlight = hoveredCol ?? currentCols - 1;
              const isHighlighted = row <= rowsToHighlight && col <= colsToHighlight;
              const isHovered = hoveredRow === row && hoveredCol === col;
              return (
                <button
                  key={`${row}-${col}`}
                  type="button"
                  aria-label={`Select ${row + 1} rows by ${col + 1} columns`}
                  className={cn(
                    "size-4 rounded-sm border transition-colors",
                    isHighlighted
                      ? "border-primary bg-primary/60"
                      : "border-border bg-background hover:border-primary/50",
                    isHovered ? "ring-1 ring-primary" : undefined,
                  )}
                  onMouseEnter={() => {
                    setHoveredRow(row);
                    setHoveredCol(col);
                  }}
                  onFocus={() => {
                    setHoveredRow(row);
                    setHoveredCol(col);
                  }}
                  onClick={() => handleSelect(row, col)}
                />
              );
            })}
          </div>
          <div className="text-center text-[10px] text-muted-foreground">
            {GRID_MIN_DIM}–{GRID_MAX_DIM} rows × {GRID_MIN_DIM}–{GRID_MAX_DIM} cols
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
