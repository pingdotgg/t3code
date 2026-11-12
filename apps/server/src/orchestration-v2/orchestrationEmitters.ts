/**
 * Event emission port for the orchestrator.
 *
 * Extracted from Orchestrator.ts as the first Stage-B boundary: emitting a domain
 * event needs an id allocator and the dispatch error mapper, and nothing else
 * from the orchestrator's closure. Handlers that only append events can now take
 * this factory's output instead of closing over the whole orchestrator.
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type {
  IdAllocatorV2Allocate,
  IdAllocatorV2Derive,
} from "@t3tools/provider-core/server/IdAllocator";

import { OrchestratorDispatchError } from "./orchestrationErrors.ts";

/* eslint-disable t3code/require-suppression-reason -- structural service typing keeps the port narrow */

/** The allocation surface the emitter needs — narrow on purpose. */
export interface EventIdAllocator {
  readonly allocate: IdAllocatorV2Allocate;
  readonly derive: IdAllocatorV2Derive;
}

/** Wrap any failure as a dispatch error carrying the command that caused it. */
export const mapDispatchError =
  (command: OrchestrationV2ServerCommand) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );

export type DispatchErrorMapper = typeof mapDispatchError;

/**
 * Builds `makeEvent` and `emit` bound to a concrete id allocator.
 *
 * The two closures are the only way domain events are created in the orchestrator;
 * passing the allocator in keeps them free of the surrounding scope.
 */
export const makeEventEmitter = (deps: { readonly idAllocator: EventIdAllocator }) => {
  const makeEvent = Effect.fnUntraced(function* <Event extends OrchestrationV2DomainEvent>(
    command: OrchestrationV2ServerCommand,
    event: Omit<Event, "id">,
  ) {
    const eventId = yield* mapDispatchError(command)(
      deps.idAllocator.allocate.event({
        threadId: event.threadId,
        commandId: command.commandId,
      }),
    );
    return {
      ...event,
      id: eventId,
    } as Event;
  });

  const emit =
    (events: Ref.Ref<Array<OrchestrationV2DomainEvent>>, command: OrchestrationV2ServerCommand) =>
    <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
      Effect.gen(function* () {
        const withId = yield* makeEvent(command, event);
        yield* Ref.update(events, (existing) => [...existing, withId]);
        return withId;
      });

  return { makeEvent, emit };
};
