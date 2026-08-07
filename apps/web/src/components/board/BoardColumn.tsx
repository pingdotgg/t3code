import { useDroppable } from "@dnd-kit/core";
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { BoardColumnId, BoardDropIntent } from "./Board.logic";

export interface BoardColumnProps {
  readonly columnId: BoardColumnId;
  readonly label: string;
  readonly count: number;
  /** Null when nothing is being dragged. Drives the drop affordance so a
      column only lights up when the drop would actually do something. */
  readonly dropIntent: BoardDropIntent | null;
  readonly dropHint: string | null;
  /** True while a settled or snoozed card is in flight: the four agent-owned
      columns then read as one "Return to active" region rather than four
      separate targets, because the card lands wherever its derived status
      puts it, not where the cursor was. */
  readonly isMergedActiveRegion: boolean;
  readonly onNewThread?: (() => void) | undefined;
  readonly children: ReactNode;
}

export function BoardColumn(props: BoardColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: `column:${props.columnId}`,
    data: { columnId: props.columnId },
  });
  const droppable = props.dropIntent !== null && props.dropIntent.kind !== "none";
  const refused = props.dropIntent !== null && props.dropIntent.kind === "none";

  return (
    <section
      className="flex h-full w-72 shrink-0 flex-col rounded-xl border border-border/40 bg-muted/10"
      aria-label={props.label}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <h2 className="text-[13px] font-medium text-foreground/90">{props.label}</h2>
        <span className="text-[11px] text-muted-foreground/60 tabular-nums">{props.count}</span>
        {props.onNewThread ? (
          <button
            type="button"
            aria-label="New thread"
            onClick={props.onNewThread}
            className="ml-auto inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </button>
        ) : null}
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2",
          droppable && "rounded-lg outline-1 outline-dashed outline-border/70",
          droppable && isOver && "bg-accent/40 outline-primary/60",
          props.isMergedActiveRegion && "outline-primary/40",
          refused && isOver && "opacity-60",
        )}
      >
        {props.dropHint !== null && isOver ? (
          <p
            className={cn(
              "rounded-md px-2 py-1 text-[11px]",
              droppable ? "bg-accent text-foreground" : "bg-muted/40 text-muted-foreground/80",
            )}
          >
            {props.dropHint}
          </p>
        ) : null}
        {props.children}
      </div>
    </section>
  );
}
