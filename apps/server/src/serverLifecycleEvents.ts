import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export interface ServerLifecycleEventsShape {
  readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
  readonly snapshot: Effect.Effect<SnapshotState>;
  readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends ServiceMap.Service<
  ServerLifecycleEvents,
  ServerLifecycleEventsShape
>()("t3/serverLifecycleEvents") {}

export const ServerLifecycleEventsLive = Layer.effect(
  ServerLifecycleEvents,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
    const state = yield* Ref.make<SnapshotState>({
      sequence: 0,
      events: [],
    });

    return {
      publish: (event) =>
        Ref.modify(state, (current) => {
          const nextSequence = current.sequence + 1;
          const nextEvent = {
            ...event,
            sequence: nextSequence,
          } satisfies ServerLifecycleStreamEvent;
          const nextEvents =
            nextEvent.type === "welcome"
              ? [nextEvent, ...current.events.filter((entry) => entry.type !== "welcome")]
              : [nextEvent, ...current.events.filter((entry) => entry.type !== "ready")];
          return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
        }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event))),
      snapshot: Ref.get(state),
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies ServerLifecycleEventsShape;
  }),
);
