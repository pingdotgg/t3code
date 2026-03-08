import type { OrchestrationEvent, OrchestrationEventType } from "@t3tools/contracts";
import { Array as EffectArray, HashMap, Option, String as EffectString, pipe } from "effect";

export interface TraceStep {
  readonly id: string;
  readonly actor: TraceActor;
  readonly title: string;
  readonly detail: string;
  readonly eventType?: OrchestrationEventType;
}

export type TraceActor =
  | "Client"
  | "wsServer"
  | "Orchestration"
  | "ProviderManager"
  | "Codex App Server"
  | "Projector/UI";

export interface ArchitectureTrace {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly actors: ReadonlyArray<TraceActor>;
  readonly steps: ReadonlyArray<TraceStep>;
}

const ACTOR_BY_EVENT_TYPE = HashMap.fromIterable<OrchestrationEventType, TraceActor>([
  ["thread.turn-start-requested", "Client"],
  ["thread.turn-interrupt-requested", "Client"],
  ["thread.approval-response-requested", "Client"],
  ["thread.user-input-response-requested", "Client"],
  ["thread.checkpoint-revert-requested", "Client"],
  ["thread.session-stop-requested", "Client"],
  ["thread.session-set", "ProviderManager"],
  ["thread.activity-appended", "ProviderManager"],
  ["thread.message-sent", "ProviderManager"],
  ["thread.proposed-plan-upserted", "ProviderManager"],
  ["thread.turn-diff-completed", "Orchestration"],
  ["thread.reverted", "Orchestration"],
  ["thread.created", "Orchestration"],
  ["thread.deleted", "Orchestration"],
  ["thread.meta-updated", "Orchestration"],
  ["thread.runtime-mode-set", "Orchestration"],
  ["thread.interaction-mode-set", "Orchestration"],
  ["project.created", "Orchestration"],
  ["project.meta-updated", "Orchestration"],
  ["project.deleted", "Orchestration"],
]);

const TRACE_DEFINITIONS: ReadonlyArray<ArchitectureTrace> = [
  {
    id: "session-startup",
    name: "Session startup / resume",
    summary: "How wsServer + providerManager bring a Codex app-server session online.",
    actors: ["Client", "wsServer", "ProviderManager", "Codex App Server", "Projector/UI"],
    steps: [
      {
        id: "startup-1",
        actor: "Client",
        title: "Turn requested",
        detail: "A client command starts a turn which bootstraps provider session orchestration.",
        eventType: "thread.turn-start-requested",
      },
      {
        id: "startup-2",
        actor: "ProviderManager",
        title: "Session entering startup",
        detail: "Provider manager persists thread.session-set(starting) while spawning/reusing Codex app-server.",
        eventType: "thread.session-set",
      },
      {
        id: "startup-3",
        actor: "Codex App Server",
        title: "Provider runtime handshake",
        detail: "Session emits provider runtime events; orchestration translates them into domain activities.",
        eventType: "thread.activity-appended",
      },
      {
        id: "startup-4",
        actor: "Projector/UI",
        title: "Snapshot projection refresh",
        detail: "Domain event push causes read-model projection refresh in the UI.",
      },
    ],
  },
  {
    id: "turn-lifecycle",
    name: "Turn lifecycle (request → diff)",
    summary: "Full request pipeline from message send to diff completion.",
    actors: ["Client", "wsServer", "ProviderManager", "Codex App Server", "Orchestration"],
    steps: [
      {
        id: "turn-1",
        actor: "Client",
        title: "Turn command submitted",
        detail: "thread.turn-start-requested captures runtime + model intent.",
        eventType: "thread.turn-start-requested",
      },
      {
        id: "turn-2",
        actor: "ProviderManager",
        title: "Assistant output streamed",
        detail: "Assistant text and plan updates are persisted as thread.message-sent / proposed-plan events.",
        eventType: "thread.message-sent",
      },
      {
        id: "turn-3",
        actor: "ProviderManager",
        title: "Tool activity appended",
        detail: "Provider tool calls + metadata are normalized into thread.activity-appended.",
        eventType: "thread.activity-appended",
      },
      {
        id: "turn-4",
        actor: "Orchestration",
        title: "Diff completed",
        detail: "Turn checkpoint and diff artifact are committed.",
        eventType: "thread.turn-diff-completed",
      },
    ],
  },
  {
    id: "ws-projection",
    name: "WebSocket projection sync",
    summary: "wsServer push events + replay keep the client read-model monotonic and recoverable.",
    actors: ["wsServer", "Projector/UI", "Client"],
    steps: [
      {
        id: "sync-1",
        actor: "wsServer",
        title: "Domain event push",
        detail: "orchestration.domainEvent is broadcast with strict sequence ordering.",
      },
      {
        id: "sync-2",
        actor: "Projector/UI",
        title: "Monotonic guard",
        detail: "Client ignores stale sequence numbers and only advances forward.",
      },
      {
        id: "sync-3",
        actor: "Client",
        title: "Replay for healing",
        detail: "Client can replay events from sequence cursor to recover gaps after reconnect.",
      },
    ],
  },
];

export const ARCHITECTURE_TRACES = TRACE_DEFINITIONS;

export function actorForEvent(event: OrchestrationEvent): TraceActor {
  return pipe(
    HashMap.get(ACTOR_BY_EVENT_TYPE, event.type),
    Option.getOrElse(() => "Orchestration" as const),
  );
}

export function matchesTrace(trace: ArchitectureTrace, event: OrchestrationEvent): boolean {
  return pipe(
    trace.steps,
    EffectArray.some((step) => step.eventType === event.type),
  );
}

export function classifyEvent(event: OrchestrationEvent): ReadonlyArray<string> {
  return pipe(
    ARCHITECTURE_TRACES,
    EffectArray.filter((trace) => matchesTrace(trace, event)),
    EffectArray.map((trace) => trace.id),
  );
}

export function filterEventsForTrace(
  events: ReadonlyArray<OrchestrationEvent>,
  traceId: string,
): ReadonlyArray<OrchestrationEvent> {
  if (traceId === "all") {
    return events.toSorted((left, right) => left.sequence - right.sequence);
  }

  return pipe(
    events,
    EffectArray.filter((event) => pipe(classifyEvent(event), EffectArray.contains(traceId))),
    (filtered) => filtered.toSorted((left, right) => left.sequence - right.sequence),
  );
}

export function compactEventLabel(eventType: OrchestrationEventType): string {
  return pipe(eventType, EffectString.replaceAll("thread.", ""), EffectString.replaceAll("project.", ""));
}

export interface EventSparklineBar {
  readonly key: string;
  readonly count: number;
}

export function eventSparkline(events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<EventSparklineBar> {
  const byType = pipe(
    events,
    EffectArray.reduce(HashMap.empty<string, number>(), (acc, event) => {
      const previous = pipe(HashMap.get(acc, event.type), Option.getOrElse(() => 0));
      return HashMap.set(acc, event.type, previous + 1);
    }),
  );

  return pipe(
    HashMap.entries(byType),
    (entries) => Array.from(entries),
    (entries) => entries.toSorted((left, right) => right[1] - left[1]),
    EffectArray.take(8),
    EffectArray.map(([key, count]) => ({ key, count })),
  );
}
