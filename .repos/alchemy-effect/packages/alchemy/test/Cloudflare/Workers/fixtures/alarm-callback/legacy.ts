import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";

export class LegacyAlarmObject extends Cloudflare.DurableObject<LegacyAlarmObject>()(
  "LegacyAlarmObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const registered = yield* Alchemy.makeCallback(
        "registered",
        Effect.fn(function* (payload: { value: string }) {
          yield* state.storage.put("registered", payload.value);
        }),
      );
      return {
        start: Effect.fn(
          function* () {
            const at = yield* Effect.sync(() => new Date(Date.now() + 1_500));
            yield* state.storage.transaction(
              Effect.gen(function* () {
                yield* registered.schedule("shared-id", {
                  at,
                  payload: { value: "registered" },
                });
                yield* Cloudflare.scheduleEvent("shared-id", at, {
                  value: "legacy",
                });
                yield* Cloudflare.scheduleEvent("cancelled", at, {
                  value: "cancelled",
                });
                yield* Cloudflare.cancelEvent("cancelled");
              }),
            );
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
        alarm: Effect.fn(
          function* () {
            const events = yield* Cloudflare.processScheduledEvents;
            const fired =
              (yield* state.storage.get<Cloudflare.ScheduledEvent[]>(
                "legacy",
              )) ?? [];
            yield* state.storage.put("legacy", [...fired, ...events]);
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
        snapshot: Effect.fn(
          function* () {
            return {
              registered:
                (yield* state.storage.get<string>("registered")) ?? null,
              legacy:
                (yield* state.storage.get<Cloudflare.ScheduledEvent[]>(
                  "legacy",
                )) ?? [],
              pending: yield* Cloudflare.listEvents,
              alarm: yield* state.storage.getAlarm(),
            };
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
      };
    });
  }),
) {}
