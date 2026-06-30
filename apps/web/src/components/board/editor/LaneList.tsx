import type { WorkflowLintError } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { lintErrorMatchesLane, type WorkflowLaneEncoded } from "./WorkflowEditor";

export function LaneList({
  lanes,
  lintErrors,
  selectedLaneKey,
  disabled = false,
  onAdd,
  onSelect,
}: {
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly selectedLaneKey: string | null;
  readonly disabled?: boolean;
  readonly onAdd: () => void;
  readonly onSelect: (laneKey: string) => void;
}) {
  return (
    <nav className="flex min-h-0 flex-col gap-2 border-r border-border bg-muted/20 p-3 max-md:border-r-0 max-md:border-b">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
          Lanes
        </h3>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Add lane"
          disabled={disabled}
          onClick={onAdd}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 space-y-1 overflow-auto">
        {lanes.map((lane) => {
          const laneKey = String(lane.key);
          const selected = laneKey === selectedLaneKey;
          const hasLintError = lintErrors.some((lintError) =>
            lintErrorMatchesLane(lintError, laneKey),
          );
          const pipelineCount = lane.pipeline?.length ?? 0;
          return (
            <button
              key={laneKey}
              type="button"
              aria-label={lane.name}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "w-full rounded-md border border-transparent px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-border bg-background shadow-xs"
                  : "hover:border-border/60 hover:bg-background/60",
                hasLintError && "border-warning/60 bg-warning/8",
              )}
              onClick={() => onSelect(laneKey)}
            >
              <span className="block truncate text-sm font-medium text-foreground">
                {lane.name}
              </span>
              <span
                className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground"
                aria-hidden="true"
              >
                <span>{lane.entry}</span>
                <span>{pipelineCount} steps</span>
                {lane.wipLimit === undefined ? null : <span>WIP {lane.wipLimit}</span>}
                {lane.terminal ? <span>terminal</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
