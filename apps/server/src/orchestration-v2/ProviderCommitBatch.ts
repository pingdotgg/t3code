import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

const MAX_EVENTS = 64;
const MAX_BYTES = 1024 * 1024;
const encodeQueue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const windowMs = Config.String("T3CODE_EXPERIMENTAL_COMMIT_WINDOW_MS").pipe(
  Config.withDefault("0"),
  Effect.map((raw) => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? Math.min(value, 25) : 0;
  }),
  Effect.orDie,
);

type Event = ProviderAdapter.ProviderAdapterV2Event;
interface Batch {
  readonly events: ReadonlyArray<Event>;
  readonly bytes: number;
  readonly openedAt: number;
  readonly reason: "deadline" | "limit" | "control" | "end" | "failure";
}

const isSnapshot = (event: Event) =>
  event.type === "node.updated" ||
  event.type === "message.updated" ||
  event.type === "turn_item.updated" ||
  event.type === "plan.updated";

export function group<E, R>(source: Stream.Stream<Event, E, R>, window: number) {
  if (window === 0)
    return source.pipe(
      Stream.map((event): Batch => ({ events: [event], bytes: 0, openedAt: 0, reason: "control" })),
    );
  type Signal =
    | { readonly _tag: "Event"; readonly event: Event; readonly bytes: number }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<E | Schema.SchemaError> }
    | { readonly _tag: "End" };
  const signals = source.pipe(
    Stream.mapEffect((event) =>
      (isSnapshot(event)
        ? encodeQueue(event).pipe(Effect.map((encoded) => Buffer.byteLength(encoded)))
        : Effect.succeed(0)
      ).pipe(Effect.map((bytes): Signal => ({ _tag: "Event", event, bytes }))),
    ),
    // A failed source must not discard the prefix already collected by the sink.
    Stream.catchCause((cause) => Stream.succeed<Signal>({ _tag: "Failure", cause })),
    Stream.concat(Stream.succeed<Signal>({ _tag: "End" })),
  );
  const collect = Sink.fold(
    () => ({ signals: [] as Array<Signal>, bytes: 0, openedAt: 0, stop: false }),
    (state) => !state.stop,
    (state, signal: Signal) =>
      Effect.gen(function* () {
        if (state.signals.length === 0) state.openedAt = yield* Clock.currentTimeMillis;
        state.signals.push(signal);
        if (signal._tag === "Event") state.bytes += signal.bytes;
        state.stop =
          signal._tag !== "Event" ||
          !isSnapshot(signal.event) ||
          state.signals.length >= MAX_EVENTS ||
          state.bytes >= MAX_BYTES;
        return state;
      }),
  );
  return signals.pipe(
    Stream.aggregateWithin(collect, Schedule.spaced(window)),
    Stream.flatMap((state) => {
      const groups: Array<Batch | Extract<Signal, { _tag: "Failure" }>> = [];
      let events: Array<Event> = [];
      let bytes = 0;
      const flush = (reason: Batch["reason"]) => {
        if (events.length === 0) return;
        groups.push({ events, bytes, openedAt: state.openedAt, reason });
        events = [];
        bytes = 0;
      };
      for (const signal of state.signals) {
        if (signal._tag === "Failure") {
          flush("failure");
          groups.push(signal);
        } else if (signal._tag === "End") flush("end");
        else if (!isSnapshot(signal.event)) {
          flush("control");
          groups.push({
            events: [signal.event],
            bytes: signal.bytes,
            openedAt: state.openedAt,
            reason: "control",
          });
        } else {
          if (bytes + signal.bytes > MAX_BYTES) flush("limit");
          events.push(signal.event);
          bytes += signal.bytes;
          if (bytes >= MAX_BYTES || events.length >= MAX_EVENTS) flush("limit");
        }
      }
      flush("deadline");
      return Stream.fromArray(groups).pipe(
        Stream.mapEffect((batch) =>
          "_tag" in batch ? Effect.failCause(batch.cause) : Effect.succeed(batch),
        ),
      );
    }),
  );
}
