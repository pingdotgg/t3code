import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { cn } from "~/lib/utils";

import { TicketCard, type TicketCardView } from "./TicketCard";

export interface LaneColumnView {
  readonly key: string;
  readonly name: string;
  readonly entry: string;
  readonly pipelineStepCount: number;
  readonly wipLimit?: number | undefined;
  readonly terminal?: boolean | undefined;
  readonly admittedTicketIds: ReadonlyArray<string>;
  readonly queuedTicketIds: ReadonlyArray<string>;
}

export function LaneColumn({
  lane,
  admittedTickets,
  queuedTickets,
  onOpen,
}: {
  readonly lane: LaneColumnView;
  readonly admittedTickets: ReadonlyArray<TicketCardView>;
  readonly queuedTickets: ReadonlyArray<TicketCardView>;
  readonly onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane:${lane.key}` });
  const tickets = [...admittedTickets, ...queuedTickets];
  const headerCount =
    lane.wipLimit === undefined
      ? String(tickets.length)
      : `${admittedTickets.length}/${lane.wipLimit}`;

  return (
    <section ref={setNodeRef} className="flex w-72 shrink-0 flex-col" aria-label={lane.name}>
      <header className="flex min-h-6 items-baseline gap-1.5 px-1.5 pb-1.5">
        <h2 className="truncate text-[13px] font-semibold text-foreground">{lane.name}</h2>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{headerCount}</span>
        {lane.wipLimit !== undefined && queuedTickets.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">
            +{queuedTickets.length} queued
          </span>
        ) : null}
        {lane.entry === "auto" ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            auto
          </span>
        ) : null}
      </header>
      <SortableContext
        items={tickets.map((ticket) => ticket.ticketId)}
        strategy={verticalListSortingStrategy}
      >
        <div
          className={cn(
            "flex min-h-16 flex-1 flex-col gap-2 rounded-lg p-1.5 transition-colors",
            isOver ? "bg-primary/4 ring-1 ring-primary/35" : "bg-muted/75",
          )}
        >
          {admittedTickets.map((ticket) => (
            <TicketCard key={ticket.ticketId} ticket={ticket} onOpen={onOpen} />
          ))}
          {queuedTickets.length > 0 ? (
            <div className="mt-1 border-t border-border/70 pt-2">
              <div className="px-1.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Queued
              </div>
              <div className="flex flex-col gap-2">
                {queuedTickets.map((ticket) => (
                  <TicketCard key={ticket.ticketId} ticket={ticket} onOpen={onOpen} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}
