import type { OrchestrationEvent } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { Array as EffectArray, Option, pipe } from "effect";
import { ActivityIcon, PlayIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  ARCHITECTURE_TRACES,
  actorForEvent,
  classifyEvent,
  compactEventLabel,
  eventSparkline,
  filterEventsForTrace,
} from "~/lib/eventLifecycle";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/_chat/events")({
  component: EventsRoutePage,
});

export function EventsRoutePage() {
  const [selectedTraceId, setSelectedTraceId] = useState<string>("all");
  const [events, setEvents] = useState<ReadonlyArray<OrchestrationEvent>>([]);
  const [isLive, setIsLive] = useState(true);

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

  const visibleEvents = useMemo(
    () => filterEventsForTrace(events, selectedTraceId),
    [events, selectedTraceId],
  );

  const traceById = useMemo(() => new Map(ARCHITECTURE_TRACES.map((trace) => [trace.id, trace])), []);
  const activeTrace = pipe(
    Option.fromNullable(traceById.get(selectedTraceId)),
    Option.getOrElse(() => null),
  );

  const bars = eventSparkline(visibleEvents);

  return (
    <main className="h-dvh min-h-0 overflow-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-6">
        <header className="rounded-xl border border-border/70 bg-card/80 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Effect lifecycle lab</p>
              <h1 className="mt-1 text-2xl font-semibold">Event trace playground</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Interactive architecture flows for orchestration domain events.
              </p>
            </div>
            <Button variant={isLive ? "default" : "outline"} size="sm" onClick={() => setIsLive((v) => !v)}>
              <PlayIcon className="mr-1 size-3.5" />
              {isLive ? "Live stream" : "Paused"}
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" data-testid="trace-selector">
            <Button
              size="sm"
              variant={selectedTraceId === "all" ? "default" : "outline"}
              onClick={() => setSelectedTraceId("all")}
            >
              All traces
            </Button>
            {ARCHITECTURE_TRACES.map((trace) => (
              <Button
                key={trace.id}
                size="sm"
                variant={selectedTraceId === trace.id ? "default" : "outline"}
                onClick={() => setSelectedTraceId(trace.id)}
              >
                {trace.name}
              </Button>
            ))}
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-xl border border-border/70 bg-card/70 p-4" data-testid="event-sequence">
            <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              <ActivityIcon className="size-4" />
              <span>{visibleEvents.length} events rendered</span>
            </div>

            <div className="space-y-2">
              {visibleEvents.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No events yet for this trace.
                </div>
              )}
              {visibleEvents.map((event) => {
                const actor = actorForEvent(event);
                const membership = classifyEvent(event);

                return (
                  <article
                    key={event.eventId}
                    className={cn(
                      "rounded-lg border border-border/70 bg-background/70 p-3 transition",
                      "hover:border-primary/50 hover:shadow-sm",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">#{event.sequence}</Badge>
                        <span className="font-mono text-xs text-primary">{compactEventLabel(event.type)}</span>
                      </div>
                      <Badge>{actor}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{JSON.stringify(event.payload)}</p>
                    {membership.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {membership.map((traceId) => (
                          <Badge key={traceId} variant="outline" className="text-[10px]">
                            {traceById.get(traceId)?.name ?? traceId}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>

          <aside className="space-y-4">
            <section className="rounded-xl border border-border/70 bg-card/70 p-4" data-testid="trace-details">
              <div className="mb-2 flex items-center gap-2">
                <SparklesIcon className="size-4 text-primary" />
                <h2 className="text-sm font-medium">Sequence guide</h2>
              </div>
              {activeTrace ? (
                <>
                  <p className="text-sm">{activeTrace.summary}</p>
                  <ol className="mt-3 space-y-2">
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
                <p className="text-sm text-muted-foreground">Showing all defined flows.</p>
              )}
            </section>
            <section className="rounded-xl border border-border/70 bg-card/70 p-4" data-testid="trace-sparkline">
              <h2 className="mb-2 text-sm font-medium">Event intensity</h2>
              <div className="flex h-20 items-end gap-1">
                {pipe(
                  bars,
                  EffectArray.map((bar, index) => (
                    <div
                      key={bar.key}
                      className="w-4 rounded-t-sm bg-primary/80"
                      style={{ height: `${Math.max(15, bar.count * 10)}%` }}
                      title={`event bucket ${index + 1}: ${bar.count}`}
                    />
                  )),
                )}
                {bars.length === 0 && <p className="text-xs text-muted-foreground">Waiting for events…</p>}
              </div>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
