import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "legacyThreadMigration" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  {
    readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
    readonly snapshot: Effect.Effect<SnapshotState>;
    readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
    /** Completes once the first ready event is published. */
    readonly awaitReady: Effect.Effect<void>;
  }
>()("t3/serverLifecycleEvents") {}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
  const ready = yield* Deferred.make<void>();
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
        const nextEvents = [
          nextEvent,
          ...current.events.filter((entry) => entry.type !== nextEvent.type),
        ];
        return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
      }).pipe(
        Effect.tap((event) => PubSub.publish(pubsub, event)),
        Effect.tap((event) =>
          event.type === "ready" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
      ),
    snapshot: Ref.get(state),
    awaitReady: Deferred.await(ready),
    get stream() {
      return Stream.fromPubSub(pubsub);
    },
  } satisfies ServerLifecycleEvents["Service"];
});

export const layer = Layer.effect(ServerLifecycleEvents, make);
