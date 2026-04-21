import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Ref } from "effect";

import {
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
  type ProjectionStoreV2Shape,
} from "../Services/ProjectionStore.ts";

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }

  const updated = [...items];
  updated[index] = next;
  return updated;
}

function emptyProjection(
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
  return {
    thread: event.payload,
    runs: [],
    attempts: [],
    nodes: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeItems: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    updatedAt: event.occurredAt,
  };
}

function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  const base = {
    ...projection,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "thread.created":
      return {
        ...base,
        thread: event.payload,
      };
    case "run.created":
    case "run.updated":
      return {
        ...base,
        runs: upsertById(base.runs, event.payload),
      };
    case "run-attempt.created":
      return {
        ...base,
        attempts: upsertById(base.attempts, event.payload),
      };
    case "node.updated":
      return {
        ...base,
        nodes: upsertById(base.nodes, event.payload),
      };
    case "provider-thread.updated":
      return {
        ...base,
        providerThreads: upsertById(base.providerThreads, event.payload),
      };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertById(base.providerTurns, event.payload),
      };
    case "runtime-item.updated":
      return {
        ...base,
        runtimeItems: upsertById(base.runtimeItems, event.payload),
      };
    case "runtime-request.updated":
      return {
        ...base,
        runtimeRequests: upsertById(base.runtimeRequests, event.payload),
      };
    case "message.updated":
      return {
        ...base,
        messages: upsertById(base.messages, event.payload),
      };
    case "turn-item.updated":
      return {
        ...base,
        turnItems: upsertById(base.turnItems, event.payload),
      };
    case "plan.updated":
      return {
        ...base,
        plans: upsertById(base.plans, event.payload),
      };
    case "checkpoint-scope.created":
      return {
        ...base,
        checkpointScopes: upsertById(base.checkpointScopes, event.payload),
      };
    case "checkpoint.captured":
      return {
        ...base,
        checkpoints: upsertById(base.checkpoints, event.payload),
      };
    case "context-handoff.updated":
      return {
        ...base,
        contextHandoffs: upsertById(base.contextHandoffs, event.payload),
      };
  }
}

export const ProjectionStoreV2MemoryLayer: Layer.Layer<ProjectionStoreV2> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const projections = yield* Ref.make(new Map<ThreadId, OrchestrationV2ThreadProjection>());

    const service: ProjectionStoreV2Shape = {
      apply: (event) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(projections, (existing) => {
            const next = new Map(existing);

            if (event.type === "thread.created" && !next.has(event.threadId)) {
              next.set(event.threadId, emptyProjection(event));
              return [undefined, next] as const;
            }

            const projection = next.get(event.threadId);
            if (!projection) {
              return [
                new ProjectionStoreThreadNotFoundError({ threadId: event.threadId }),
                existing,
              ] as const;
            }

            next.set(event.threadId, applyToProjection(projection, event));
            return [undefined, next] as const;
          });

          if (result) {
            return yield* result;
          }
        }),
      getThreadProjection: (threadId) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(projections);
          const projection = existing.get(threadId);
          if (!projection) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection;
        }),
    };

    return service;
  }),
);
