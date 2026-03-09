import type { OrchestrationEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Array as EffectArray, Option, pipe } from "effect";
import { FilterIcon, PlayIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCallback } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  type ArchitectureTrace,
  ARCHITECTURE_TRACES,
  actorForEvent,
  compactEventLabel,
  compactEventTypeLabel,
  eventDetailSummary,
  eventTurnId,
  filterEventsByAggregate,
  filterEventsForTrace,
} from "~/lib/eventLifecycle";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

function parseEventsSearch(raw: Record<string, unknown>): { event?: number } {
  const event = Number(raw.event);
  return Number.isFinite(event) ? { event } : {};
}

export const Route = createFileRoute("/_chat/$threadId/events")({
  validateSearch: parseEventsSearch,
  component: EventsRoutePage,
});

const ACTOR_COLORS: Record<string, string> = {
  Client: "bg-blue-500",
  wsServer: "bg-violet-500",
  Orchestration: "bg-amber-500",
  ProviderManager: "bg-emerald-500",
  "Codex App Server": "bg-rose-500",
  "Projector/UI": "bg-cyan-500",
};

const ACTOR_TEXT_COLORS: Record<string, string> = {
  Client: "text-blue-500",
  wsServer: "text-violet-500",
  Orchestration: "text-amber-500",
  ProviderManager: "text-emerald-500",
  "Codex App Server": "text-rose-500",
  "Projector/UI": "text-cyan-500",
};

const ACTOR_BG_MUTED: Record<string, string> = {
  Client: "bg-blue-500/10",
  wsServer: "bg-violet-500/10",
  Orchestration: "bg-amber-500/10",
  ProviderManager: "bg-emerald-500/10",
  "Codex App Server": "bg-rose-500/10",
  "Projector/UI": "bg-cyan-500/10",
};

function collectUniqueActors(events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<string> {
  return pipe(
    events,
    EffectArray.map(actorForEvent),
    EffectArray.dedupe,
  );
}

function collectUniqueTypes(events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<string> {
  return pipe(
    events,
    EffectArray.map((e) => e.type),
    EffectArray.dedupe,
  );
}

const ACTOR_SVG_COLORS: Record<string, string> = {
  Client: "#3b82f6",
  wsServer: "#8b5cf6",
  Orchestration: "#f59e0b",
  ProviderManager: "#10b981",
  "Codex App Server": "#f43f5e",
  "Projector/UI": "#06b6d4",
};

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function formatPrimitive(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

function primitiveColorClass(value: unknown): string {
  if (value === null || value === undefined) return "text-muted-foreground/70";
  if (typeof value === "string") return "text-emerald-500 dark:text-emerald-400";
  if (typeof value === "number") return "text-blue-500 dark:text-blue-400";
  if (typeof value === "boolean") return "text-amber-500 dark:text-amber-400";
  return "text-foreground";
}

function PayloadNode({
  field,
  value,
  level,
  last,
  onFilter,
}: {
  field: string | undefined;
  value: unknown;
  level: number;
  last: boolean;
  onFilter: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(level < 3);

  const indent = level * 16;

  if (isPrimitive(value)) {
    const displayValue = formatPrimitive(value);
    const filterValue = value === null || value === undefined ? "" : String(value);
    return (
      <div className="group/node flex items-center font-mono text-[11px] leading-[22px]" style={{ paddingLeft: indent }}>
        <span className="min-w-0 flex-1">
          {field !== undefined && <span className="text-foreground/80">{field}<span className="text-muted-foreground/60">: </span></span>}
          <span className={primitiveColorClass(value)}>{displayValue}</span>
          {!last && <span className="text-muted-foreground/40">,</span>}
        </span>
        {filterValue.length > 0 && (
          <button
            type="button"
            className="mr-1 shrink-0 rounded border border-border/60 bg-muted/50 p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:border-primary/40 hover:bg-primary/10 hover:text-primary group-hover/node:opacity-100"
            title={`Filter by ${field ?? "value"}: ${filterValue}`}
            onClick={() => onFilter(filterValue)}
          >
            <FilterIcon className="size-3" />
          </button>
        )}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";

  if (entries.length === 0) {
    return (
      <div className="font-mono text-[11px] leading-[22px]" style={{ paddingLeft: indent }}>
        {field !== undefined && <span className="text-foreground/80">{field}<span className="text-muted-foreground/60">: </span></span>}
        <span className="text-muted-foreground/60">{openBracket}{closeBracket}</span>
        {!last && <span className="text-muted-foreground/40">,</span>}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="flex w-full select-none items-center gap-0.5 font-mono text-[11px] leading-[22px] text-muted-foreground/60 hover:text-foreground/80"
        style={{ paddingLeft: indent }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="inline-block w-3 text-center text-[9px]">{expanded ? "▼" : "▶"}</span>
        {field !== undefined && <span className="text-foreground/80">{field}<span className="text-muted-foreground/60">: </span></span>}
        {!expanded && (
          <span className="text-muted-foreground/50">{openBracket} {entries.length} {isArray ? "items" : "keys"} {closeBracket}{!last && ","}</span>
        )}
        {expanded && <span>{openBracket}</span>}
      </button>
      {expanded && (
        <>
          {entries.map(([key, val], i) => (
            <PayloadNode
              key={key}
              field={isArray ? undefined : key}
              value={val}
              level={level + 1}
              last={i === entries.length - 1}
              onFilter={onFilter}
            />
          ))}
          <div className="select-none font-mono text-[11px] leading-[22px] text-muted-foreground/60" style={{ paddingLeft: indent }}>
            <span className="inline-block w-3" />{closeBracket}{!last && <span className="text-muted-foreground/40">,</span>}
          </div>
        </>
      )}
    </>
  );
}

function PayloadTree({ data, onFilter }: { data: unknown; onFilter: (value: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <PayloadNode field={undefined} value={data} level={0} last onFilter={onFilter} />
    </div>
  );
}

/** GitHub contributions-style grid: events flow top→bottom then wrap to the next column. */
function ContributionsGrid({
  events,
  selectedEvent,
  highlightTurnId,
  onSelectEvent,
}: {
  events: ReadonlyArray<OrchestrationEvent>;
  selectedEvent: OrchestrationEvent | null;
  highlightTurnId: string | null;
  onSelectEvent: (event: OrchestrationEvent | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const CELL = 11;
  const GAP = 2;
  const STEP = CELL + GAP;
  const PAD = 4;

  const rows = containerHeight > 0 ? Math.max(Math.floor((containerHeight - PAD * 2) / STEP), 1) : 7;
  const cols = Math.ceil(events.length / rows);
  const svgWidth = cols * STEP + GAP + PAD * 2;
  const svgHeight = rows * STEP + GAP + PAD * 2;

  const selectedIndex = selectedEvent ? events.findIndex((e) => e.eventId === selectedEvent.eventId) : -1;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || selectedIndex < 0 || rows === 0) return;
    const col = Math.floor(selectedIndex / rows);
    const targetX = col * STEP + PAD;
    const halfView = el.clientWidth / 2;
    el.scrollTo({ left: targetX - halfView + STEP / 2, behavior: "smooth" });
  }, [selectedIndex, rows, STEP, PAD]);

  return (
    <div
      ref={containerRef}
      className="shrink-0 overflow-x-auto overflow-y-hidden border-b border-border/70 bg-card/50 px-1"
      style={{ height: Math.min(Math.max(rows * STEP + PAD * 2, 60), 160) }}
    >
      <svg width={svgWidth} height={svgHeight} className="block">
        {events.map((event, i) => {
          const col = Math.floor(i / rows);
          const row = i % rows;
          const x = col * STEP + GAP + PAD;
          const y = row * STEP + GAP + PAD;
          const isSelected = selectedEvent?.eventId === event.eventId;
          const isAssociated =
            !isSelected && highlightTurnId !== null && eventTurnId(event) === highlightTurnId;
          const actor = actorForEvent(event);
          const fill = ACTOR_SVG_COLORS[actor] ?? "#888";

          return (
            <g
              key={event.eventId}
              className="cursor-pointer"
              onClick={() => onSelectEvent(isSelected ? null : event)}
            >
              <title>
                #{event.sequence} {compactEventLabel(event)} ({actor})
              </title>
              {(isSelected || isAssociated) && (
                <rect
                  x={x - 2}
                  y={y - 2}
                  width={CELL + 4}
                  height={CELL + 4}
                  rx={3}
                  fill={isSelected ? fill : "#fff"}
                  fillOpacity={isSelected ? 0.25 : 0.15}
                  stroke={fill}
                  strokeWidth={isAssociated ? 1 : 0}
                  strokeOpacity={0.5}
                />
              )}
              <rect
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={2}
                fill={fill}
                fillOpacity={isSelected ? 1 : isAssociated ? 0.9 : 0.65}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function EventsRoutePage() {
  const threadId = Route.useParams({ select: (p) => ThreadId.makeUnsafe(p.threadId) });
  const navigate = useNavigate();
  const selectedSequence = Route.useSearch({ select: (s) => s.event ?? null });
  const [selectedTraceId, setSelectedTraceId] = useState<string>("all");
  const [events, setEvents] = useState<ReadonlyArray<OrchestrationEvent>>([]);
  const [isLive, setIsLive] = useState(true);
  const [search, setSearch] = useState("");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    let disposed = false;

    void api.orchestration.replayEvents(0).then((replayed) => {
      if (disposed) return;
      setEvents(replayed);
    });

    const unsubscribe = api.orchestration.onDomainEvent((event) => {
      if (!isLive) return;
      setEvents((current) => {
        if (current.some((entry) => entry.sequence === event.sequence)) {
          return current;
        }
        return [...current, event].toSorted((left, right) => left.sequence - right.sequence);
      });
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [isLive]);

  const threadEvents = useMemo(() => filterEventsByAggregate(events, threadId), [events, threadId]);

  const availableActors = useMemo(() => collectUniqueActors(threadEvents), [threadEvents]);
  const availableTypes = useMemo(() => collectUniqueTypes(threadEvents), [threadEvents]);

  const visibleEvents = useMemo(() => {
    let filtered = filterEventsForTrace(threadEvents, selectedTraceId);

    if (actorFilter !== "all") {
      filtered = pipe(
        filtered,
        EffectArray.filter((e) => actorForEvent(e) === actorFilter),
      );
    }

    if (typeFilter !== "all") {
      filtered = pipe(
        filtered,
        EffectArray.filter((e) => e.type === typeFilter),
      );
    }

    if (search.trim()) {
      const query = search.trim().toLowerCase();
      filtered = pipe(
        filtered,
        EffectArray.filter(
          (e) =>
            e.type.toLowerCase().includes(query) ||
            actorForEvent(e).toLowerCase().includes(query) ||
            String(e.sequence).includes(query) ||
            JSON.stringify(e.payload).toLowerCase().includes(query),
        ),
      );
    }

    return filtered;
  }, [threadEvents, selectedTraceId, actorFilter, typeFilter, search]);

  const traceById = useMemo(() => new Map(ARCHITECTURE_TRACES.map((trace) => [trace.id, trace])), []);
  const activeTrace = pipe(
    Option.fromNullishOr(traceById.get(selectedTraceId)),
    Option.getOrElse(() => null as ArchitectureTrace | null),
  );

  const selectedEvent = useMemo(
    () => (selectedSequence !== null ? threadEvents.find((e) => e.sequence === selectedSequence) ?? null : null),
    [threadEvents, selectedSequence],
  );

  const selectEvent = (event: OrchestrationEvent | null) => {
    void navigate({
      to: ".",
      search: event === null ? {} : { event: event.sequence },
      replace: true,
    });
  };

  const applyPayloadFilter = useCallback((value: string) => {
    setSearch(value);
  }, []);

  const hasActiveFilters = search.trim() || actorFilter !== "all" || typeFilter !== "all" || selectedTraceId !== "all";

  const highlightTurnId = useMemo(
    () => (selectedEvent ? eventTurnId(selectedEvent) : null),
    [selectedEvent],
  );

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex flex-1 flex-col overflow-hidden">
        <ContributionsGrid
          events={visibleEvents}
          selectedEvent={selectedEvent}
          highlightTurnId={highlightTurnId}
          onSelectEvent={selectEvent}
        />

        <div className="shrink-0 border-b border-border/70 bg-card/80 px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search events by type, actor, sequence, or payload..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                data-testid="event-search"
              />
            </div>

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary/50"
              data-testid="type-filter"
            >
              <option value="all">All types</option>
              {availableTypes.map((type) => (
                <option key={type} value={type}>
                  {compactEventTypeLabel(type as OrchestrationEvent["type"])}
                </option>
              ))}
            </select>

            <select
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary/50"
              data-testid="actor-filter"
            >
              <option value="all">All actors</option>
              {availableActors.map((actor) => (
                <option key={actor} value={actor}>
                  {actor}
                </option>
              ))}
            </select>

            <select
              value={selectedTraceId}
              onChange={(e) => setSelectedTraceId(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary/50"
              data-testid="trace-selector"
            >
              <option value="all">All traces</option>
              {ARCHITECTURE_TRACES.map((trace) => (
                <option key={trace.id} value={trace.id}>
                  {trace.name}
                </option>
              ))}
            </select>

            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => {
                  setSearch("");
                  setActorFilter("all");
                  setTypeFilter("all");
                  setSelectedTraceId("all");
                }}
              >
                <XIcon className="mr-1 size-3" />
                Clear
              </Button>
            )}

            <div className="h-4 w-px bg-border" />

            <Button
              variant={isLive ? "default" : "outline"}
              size="sm"
              className="h-8"
              onClick={() => setIsLive((v) => !v)}
            >
              <PlayIcon className="mr-1 size-3" />
              {isLive ? "Live" : "Paused"}
            </Button>

            <span className="text-xs tabular-nums text-muted-foreground">{visibleEvents.length} events</span>
          </div>
        </div>

        <section className="grid min-h-0 flex-1 lg:grid-cols-[2fr_1fr]">
          <div className="min-h-0 overflow-y-auto" data-testid="event-sequence">
            {visibleEvents.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {hasActiveFilters ? "No events match your filters." : "No events yet."}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-card/95 text-left text-muted-foreground backdrop-blur">
                  <tr className="border-b border-border/70">
                    <th className="px-3 py-1.5 font-medium">#</th>
                    <th className="px-3 py-1.5 font-medium">Type</th>
                    <th className="px-3 py-1.5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map((event) => {
                    const isSelected = selectedEvent?.eventId === event.eventId;
                    const isAssociated =
                      !isSelected && highlightTurnId !== null && eventTurnId(event) === highlightTurnId;
                    const actor = actorForEvent(event);

                    return (
                      <tr
                        key={event.eventId}
                        ref={isSelected ? (el) => el?.scrollIntoView({ block: "center", behavior: "smooth" }) : undefined}
                        className={cn(
                          "cursor-pointer border-b border-border/40 transition-colors",
                          "hover:bg-primary/5",
                          isSelected && "bg-primary/10",
                          isAssociated && "bg-primary/[0.04]",
                        )}
                        onClick={() => selectEvent(isSelected ? null : event)}
                      >
                        <td className={cn("px-3 py-1.5 tabular-nums text-muted-foreground", isAssociated && "border-l-2 border-l-primary/30")}>{event.sequence}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 font-mono",
                              ACTOR_TEXT_COLORS[actor] ?? "text-primary",
                            )}
                          >
                            <span
                              className={cn("inline-block size-2 shrink-0 rounded-full", ACTOR_COLORS[actor] ?? "bg-muted-foreground")}
                            />
                            {compactEventLabel(event)}
                          </span>
                        </td>
                        <td className="truncate px-3 py-1.5 text-muted-foreground">
                          {eventDetailSummary(event)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <aside className="min-h-0 overflow-y-auto border-l border-border/70">
            {selectedEvent !== null ? (
              <div className="p-4" data-testid="event-detail">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">#{selectedEvent.sequence}</Badge>
                    <span className="font-mono text-xs text-primary">{compactEventLabel(selectedEvent)}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => selectEvent(null)}
                    data-testid="close-detail"
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>

                <div className="mb-3 flex items-center gap-2">
                  <Badge
                    className={cn(
                      ACTOR_BG_MUTED[actorForEvent(selectedEvent)],
                      ACTOR_TEXT_COLORS[actorForEvent(selectedEvent)],
                    )}
                  >
                    {actorForEvent(selectedEvent)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{selectedEvent.occurredAt}</span>
                </div>

                <div className="mb-3 space-y-1 text-xs text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">Event ID:</span> {selectedEvent.eventId}
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Aggregate:</span> {selectedEvent.aggregateKind} /{" "}
                    {selectedEvent.aggregateId}
                  </p>
                  {selectedEvent.commandId && (
                    <p>
                      <span className="font-medium text-foreground">Command ID:</span> {selectedEvent.commandId}
                    </p>
                  )}
                  {selectedEvent.correlationId && (
                    <p>
                      <span className="font-medium text-foreground">Correlation ID:</span>{" "}
                      {selectedEvent.correlationId}
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-border/60 bg-background/80 p-3" data-testid="event-payload">
                  <h3 className="mb-2 text-xs font-medium">Payload</h3>
                  <PayloadTree data={selectedEvent.payload} onFilter={applyPayloadFilter} />
                </div>
              </div>
            ) : (
              <div className="p-4" data-testid="trace-details">
                {activeTrace ? (
                  <>
                    <h2 className="mb-1 text-sm font-medium">{activeTrace.name}</h2>
                    <p className="mb-3 text-xs text-muted-foreground">{activeTrace.summary}</p>
                    <ol className="space-y-2">
                      {activeTrace.steps.map((step) => (
                        <li key={step.id} className="rounded-md border border-border/60 bg-background/80 p-2">
                          <p className="text-xs font-medium">{step.actor}</p>
                          <p className="text-xs text-foreground">{step.title}</p>
                          <p className="text-[11px] text-muted-foreground">{step.detail}</p>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Select an event to view its details.</p>
                )}
              </div>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}
