import { type EnvironmentId } from "@t3tools/contracts";
import { memo, useCallback } from "react";
import { Grid2X2Icon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { isElectron } from "../../env";
import { useGridLayoutStore } from "../../gridLayoutStore";
import { Button } from "../ui/button";
import { SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { GridSizePicker } from "./GridSizePicker";

interface GridToolbarProps {
  environmentId: EnvironmentId;
  rows: number;
  cols: number;
  populatedCount: number;
  totalCellCount: number;
  onChangeSize: (rows: number, cols: number) => void;
  onResetLayout: () => void;
}

export const GridToolbar = memo(function GridToolbar({
  environmentId,
  rows,
  cols,
  populatedCount,
  totalCellCount,
  onChangeSize,
  onResetLayout,
}: GridToolbarProps) {
  const navigate = useNavigate();
  const exitGrid = useCallback(() => {
    useGridLayoutStore.getState().setLastView(environmentId, "thread");
    void navigate({ to: "/", search: {} });
  }, [environmentId, navigate]);

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border bg-card px-3",
        isElectron
          ? "drag-region h-[52px] wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
          : "py-2",
      )}
    >
      <SidebarTrigger className="size-7 shrink-0 md:hidden" />
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Grid2X2Icon className="size-3.5" />
        <span>Grid view</span>
      </div>
      <div className="hidden text-[11px] text-muted-foreground sm:block">
        {populatedCount} / {totalCellCount} panes populated · env {environmentId.slice(0, 8)}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <GridSizePicker currentRows={rows} currentCols={cols} onSelect={onChangeSize} align="end" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="outline" size="xs" onClick={onResetLayout}>
                Reset layout
              </Button>
            }
          />
          <TooltipPopup side="bottom">Clear every pane in this grid.</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                onClick={exitGrid}
                aria-label="Exit grid view"
              >
                <XIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Exit grid view</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
