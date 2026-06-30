import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cva } from "class-variance-authority";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { ticketAging } from "~/workflow/agingFormat";
import { useNowTick } from "~/workflow/useNowTick";
import { ticketUsageSummary } from "~/workflow/usageFormat";

export interface TicketCardView {
  readonly ticketId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: string;
  readonly totalTokens?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly unresolvedDependencyCount?: number | undefined;
  readonly tokenBudget?: number | undefined;
  readonly updatedAt?: string | undefined;
  readonly pr?:
    | {
        readonly number: number;
        readonly url: string;
        readonly state: "open" | "merged" | "closed";
        readonly ciState?: "pending" | "success" | "failure" | undefined;
      }
    | undefined;
}

interface TicketStatusMeta {
  readonly label: string;
  readonly tone: "destructive" | "muted" | "settled" | "success" | "warning";
  readonly textClassName: string;
  /** Live execution gets a pulsing indicator; nothing else earns a dot. */
  readonly live?: boolean;
}

const ticketCardVariants = cva(
  "group w-full cursor-grab rounded-md border border-border/70 bg-card px-3 py-2.5 text-left text-sm text-card-foreground shadow-xs transition-[border-color,box-shadow,background-color] hover:border-border hover:shadow-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-default",
  {
    variants: {
      dragging: {
        false: "",
        true: "opacity-50 shadow-md",
      },
    },
    defaultVariants: {
      dragging: false,
    },
  },
);

// Status is said once, in words. Idle cards say nothing: an untouched card in
// a lane needs no extra signal beyond its position on the board.
const statusMetaByStatus: Record<string, TicketStatusMeta | undefined> = {
  idle: undefined,
  queued: {
    label: "queued",
    tone: "muted",
    textClassName: "text-muted-foreground",
  },
  running: {
    label: "running",
    tone: "success",
    textClassName: "text-success-foreground",
    live: true,
  },
  waiting_on_user: {
    label: "waiting on you",
    tone: "warning",
    textClassName: "text-warning-foreground",
  },
  blocked: {
    label: "blocked",
    tone: "warning",
    textClassName: "text-warning-foreground",
  },
  failed: {
    label: "failed",
    tone: "destructive",
    textClassName: "text-destructive-foreground",
  },
  done: {
    label: "done",
    tone: "settled",
    textClassName: "text-muted-foreground/80",
  },
};

export function TicketCard({
  ticket,
  onOpen,
}: {
  readonly ticket: TicketCardView;
  readonly onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.ticketId,
  });
  const meta = statusMetaByStatus[ticket.status] ?? null;
  const usageSummary = ticketUsageSummary(ticket);
  const unresolvedDependencies = ticket.unresolvedDependencyCount ?? 0;
  const aging = ticketAging(ticket, useNowTick(60_000));
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  // A ticket stuck on a human escalates in place: the aging label replaces the
  // plain status word rather than stacking a second indicator on the card.
  const statusLabel = aging?.label ?? meta?.label ?? null;
  const statusClassName =
    aging === null
      ? meta?.textClassName
      : aging.level === "alert"
        ? "text-destructive-foreground"
        : "text-warning-foreground";
  const showFooter = statusLabel !== null || usageSummary !== null || ticket.pr !== undefined;

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      className={ticketCardVariants({ dragging: isDragging })}
      data-status={ticket.status}
      onClick={() => onOpen(ticket.ticketId)}
      {...attributes}
      {...listeners}
    >
      <span className="block truncate font-medium leading-5">{ticket.title}</span>
      {ticket.description ? (
        <span className="mt-1 block line-clamp-2 text-xs leading-4 text-muted-foreground">
          {ticket.description}
        </span>
      ) : null}
      {unresolvedDependencies > 0 ? (
        <span
          className="mt-1.5 block text-[11px] leading-4 text-warning-foreground"
          data-testid="ticket-dependency-badge"
        >
          waiting on {unresolvedDependencies} dependenc
          {unresolvedDependencies === 1 ? "y" : "ies"}
        </span>
      ) : null}
      {showFooter ? (
        <span className="mt-2 flex items-baseline gap-1.5">
          {statusLabel !== null ? (
            <span
              className={cn(
                "flex min-w-0 items-baseline gap-1.5 truncate text-[11px] font-medium leading-4",
                statusClassName,
              )}
              data-status-tone={
                aging === null ? meta?.tone : aging.level === "alert" ? "destructive" : "warning"
              }
              data-testid="ticket-status"
            >
              {meta?.live ? (
                <span aria-hidden="true" className="relative flex size-1.5 self-center">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                </span>
              ) : null}
              {statusLabel}
            </span>
          ) : null}
          {usageSummary ? (
            <span
              className="ml-auto shrink-0 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground/90"
              data-testid="ticket-usage-summary"
            >
              {usageSummary}
            </span>
          ) : null}
          {ticket.pr !== undefined ? (
            <span
              className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground/90"
              data-testid="ticket-pr-chip"
            >
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  ticket.pr.state === "merged"
                    ? "bg-muted-foreground/50"
                    : ticket.pr.state === "closed"
                      ? "bg-muted-foreground/40"
                      : ticket.pr.ciState === "failure"
                        ? "bg-destructive"
                        : ticket.pr.ciState === "success"
                          ? "bg-success"
                          : "bg-muted-foreground/40",
                )}
              />
              #{ticket.pr.number}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
