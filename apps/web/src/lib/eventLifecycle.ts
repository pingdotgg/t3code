import type { OrchestrationDiagnosticKind, OrchestrationEvent, OrchestrationEventType } from "@t3tools/contracts";
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
  ["thread.diagnostic-appended", "Codex App Server"],
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

const DIAGNOSTIC_ACTOR_BY_KIND = HashMap.fromIterable<OrchestrationDiagnosticKind, TraceActor>([
  ["turn.started", "Codex App Server"],
  ["turn.completed", "Codex App Server"],
  ["turn.aborted", "Codex App Server"],
  ["session.configured", "Codex App Server"],
  ["session.exited", "Codex App Server"],
  ["token-usage.updated", "Codex App Server"],
  ["hook.started", "Codex App Server"],
  ["hook.progress", "Codex App Server"],
  ["hook.completed", "Codex App Server"],
  ["tool.summary", "Codex App Server"],
  ["model.rerouted", "Codex App Server"],
  ["files.persisted", "Codex App Server"],
  ["item.completed", "ProviderManager"],
  ["message.completed", "ProviderManager"],
]);

// --- Diagnostic payload access helpers ---

interface DiagnosticPayload {
  readonly diagnostic?: {
    readonly kind?: string;
    readonly summary?: string;
    readonly payload?: unknown;
  };
}

/**
 * Extract the turnId associated with an event. Checks metadata, diagnostic
 * payload, activity payload, and common payload shapes.
 */
export function eventTurnId(event: OrchestrationEvent): string | null {
  // metadata.providerTurnId (set by ingestion on many events)
  const metaTurnId = event.metadata.providerTurnId;
  if (metaTurnId) return metaTurnId;

  const payload = event.payload as Record<string, unknown>;

  // diagnostic.turnId
  const diag = payload.diagnostic as { turnId?: string | null } | undefined;
  if (diag?.turnId) return diag.turnId;

  // activity.turnId
  const activity = payload.activity as { turnId?: string | null } | undefined;
  if (activity?.turnId) return activity.turnId;

  // session.activeTurnId
  const session = payload.session as { activeTurnId?: string | null } | undefined;
  if (session?.activeTurnId) return session.activeTurnId;

  // Direct turnId on payload (turn-diff-completed, turn-start-requested via commandId correlation, etc.)
  if (typeof payload.turnId === "string") return payload.turnId;

  return null;
}

function getDiagnosticKind(event: OrchestrationEvent): string | undefined {
  if (event.type !== "thread.diagnostic-appended") return undefined;
  return (event.payload as DiagnosticPayload).diagnostic?.kind;
}

function getDiagnosticSummary(event: OrchestrationEvent): string | undefined {
  if (event.type !== "thread.diagnostic-appended") return undefined;
  return (event.payload as DiagnosticPayload).diagnostic?.summary;
}

// --- Trace definitions ---

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
        title: "Session configured",
        detail: "Codex app-server completes handshake and reports its configuration (model, provider).",
        eventType: "thread.diagnostic-appended",
      },
      {
        id: "startup-4",
        actor: "Codex App Server",
        title: "Provider runtime handshake",
        detail: "Session emits provider runtime events; orchestration translates them into domain activities.",
        eventType: "thread.activity-appended",
      },
      {
        id: "startup-5",
        actor: "Projector/UI",
        title: "Snapshot projection refresh",
        detail: "Domain event push causes read-model projection refresh in the UI.",
      },
    ],
  },
  {
    id: "turn-lifecycle",
    name: "Turn lifecycle (request → completion)",
    summary: "Full request pipeline from message send through Codex turn execution to completion.",
    actors: ["Client", "ProviderManager", "Codex App Server", "Orchestration"],
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
        actor: "Codex App Server",
        title: "Turn started",
        detail: "Codex app-server acknowledges the turn and begins processing.",
        eventType: "thread.diagnostic-appended",
      },
      {
        id: "turn-3",
        actor: "ProviderManager",
        title: "Assistant output streamed",
        detail: "Assistant text and plan updates are persisted as thread.message-sent / proposed-plan events.",
        eventType: "thread.message-sent",
      },
      {
        id: "turn-4",
        actor: "ProviderManager",
        title: "Tool activity appended",
        detail: "Provider tool calls + metadata are normalized into thread.activity-appended.",
        eventType: "thread.activity-appended",
      },
      {
        id: "turn-5",
        actor: "Codex App Server",
        title: "Turn completed",
        detail: "Codex app-server signals turn completion with final state and token usage.",
        eventType: "thread.diagnostic-appended",
      },
      {
        id: "turn-6",
        actor: "Orchestration",
        title: "Diff completed",
        detail: "Turn checkpoint and diff artifact are committed.",
        eventType: "thread.turn-diff-completed",
      },
    ],
  },
  {
    id: "tool-execution",
    name: "Tool execution pipeline",
    summary: "How Codex app-server tool calls flow through activities and diagnostics.",
    actors: ["Codex App Server", "ProviderManager", "Client"],
    steps: [
      {
        id: "tool-1",
        actor: "ProviderManager",
        title: "Tool started",
        detail: "item.started is projected as a tool activity (approval, command, file change, etc.).",
        eventType: "thread.activity-appended",
      },
      {
        id: "tool-2",
        actor: "Client",
        title: "Approval requested (if needed)",
        detail: "High-risk operations trigger request.opened → approval activity.",
        eventType: "thread.approval-response-requested",
      },
      {
        id: "tool-3",
        actor: "Codex App Server",
        title: "Tool summary",
        detail: "Codex emits tool.summary with execution result for each tool call.",
        eventType: "thread.diagnostic-appended",
      },
      {
        id: "tool-4",
        actor: "ProviderManager",
        title: "Tool completed",
        detail: "item.completed finalizes the tool activity with result payload.",
        eventType: "thread.activity-appended",
      },
    ],
  },
  {
    id: "hooks-lifecycle",
    name: "Hooks lifecycle",
    summary: "Codex app-server hook execution events (pre/post command hooks).",
    actors: ["Codex App Server"],
    steps: [
      {
        id: "hook-1",
        actor: "Codex App Server",
        title: "Hook started",
        detail: "A pre/post hook begins execution.",
        eventType: "thread.diagnostic-appended",
      },
      {
        id: "hook-2",
        actor: "Codex App Server",
        title: "Hook progress",
        detail: "Hook emits progress output during execution.",
        eventType: "thread.diagnostic-appended",
      },
      {
        id: "hook-3",
        actor: "Codex App Server",
        title: "Hook completed",
        detail: "Hook execution finishes with pass/fail status.",
        eventType: "thread.diagnostic-appended",
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

// --- Public API ---

export function actorForEvent(event: OrchestrationEvent): TraceActor {
  const kind = getDiagnosticKind(event);
  if (kind) {
    return pipe(
      HashMap.get(DIAGNOSTIC_ACTOR_BY_KIND, kind as OrchestrationDiagnosticKind),
      Option.getOrElse(() => "Codex App Server" as const),
    );
  }
  return pipe(
    HashMap.get(ACTOR_BY_EVENT_TYPE, event.type),
    Option.getOrElse(() => "Orchestration" as const),
  );
}

/**
 * Display label for an event. For diagnostic events includes the diagnostic
 * kind (e.g. "diagnostic:turn.started"), otherwise strips common prefixes.
 */
export function compactEventLabel(event: OrchestrationEvent): string {
  const kind = getDiagnosticKind(event);
  if (kind) return kind;
  return pipe(event.type as string, EffectString.replaceAll("thread.", ""), EffectString.replaceAll("project.", ""));
}

/** Label for an OrchestrationEventType string (no event context). */
export function compactEventTypeLabel(eventType: OrchestrationEventType): string {
  return pipe(eventType, EffectString.replaceAll("thread.", ""), EffectString.replaceAll("project.", ""));
}

/**
 * One-line summary suitable for the "Details" column of the event table.
 */
export function eventDetailSummary(event: OrchestrationEvent): string | undefined {
  const diagSummary = getDiagnosticSummary(event);
  if (diagSummary) return diagSummary;

  if (event.type === "thread.activity-appended") {
    const activity = (event.payload as { activity?: { kind?: string; summary?: string } }).activity;
    if (activity) return `${activity.kind}: ${activity.summary}`;
  }

  if (event.type === "thread.session-set") {
    const session = (event.payload as { session?: { status?: string } }).session;
    if (session?.status) return `status → ${session.status}`;
  }

  if (event.type === "thread.message-sent") {
    const role = (event.payload as { role?: string }).role;
    return role ? `${role} message` : undefined;
  }

  return undefined;
}

export function matchesTrace(trace: ArchitectureTrace, event: OrchestrationEvent): boolean {
  return pipe(
    trace.steps,
    EffectArray.some((step) => step.eventType === event.type),
  );
}

export function classifyEvent(event: OrchestrationEvent): ReadonlyArray<string> {
  const kind = getDiagnosticKind(event);
  if (kind) {
    const traceIds: string[] = [];
    if (kind === "session.configured" || kind === "session.exited") {
      traceIds.push("session-startup");
    }
    if (
      kind === "turn.started" ||
      kind === "turn.completed" ||
      kind === "turn.aborted" ||
      kind === "token-usage.updated"
    ) {
      traceIds.push("turn-lifecycle");
    }
    if (kind === "tool.summary" || kind === "item.completed") {
      traceIds.push("tool-execution");
    }
    if (kind === "message.completed") {
      traceIds.push("turn-lifecycle");
    }
    if (kind === "hook.started" || kind === "hook.progress" || kind === "hook.completed") {
      traceIds.push("hooks-lifecycle");
    }
    return traceIds;
  }

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

export function filterEventsByAggregate(
  events: ReadonlyArray<OrchestrationEvent>,
  aggregateId: string | null,
): ReadonlyArray<OrchestrationEvent> {
  if (aggregateId === null) return events;
  return pipe(
    events,
    EffectArray.filter((e) => e.aggregateId === aggregateId),
  );
}

export interface EventSparklineBar {
  readonly key: string;
  readonly count: number;
}

export function eventSparkline(events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<EventSparklineBar> {
  const byType = pipe(
    events,
    EffectArray.reduce(HashMap.empty<string, number>(), (acc, event) => {
      const label = compactEventLabel(event);
      const previous = pipe(HashMap.get(acc, label), Option.getOrElse(() => 0));
      return HashMap.set(acc, label, previous + 1);
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
