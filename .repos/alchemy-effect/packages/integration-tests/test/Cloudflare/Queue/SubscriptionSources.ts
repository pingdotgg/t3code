import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const makeSubscriptionCleanup = () => {
  let deadline: number | undefined;
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      deadline ??= now + 20_000;
      const remaining = deadline - now;
      if (remaining <= 0) {
        return yield* Effect.die(new Error("Subscription cleanup deadline exceeded"));
      }
      return yield* effect.pipe(Effect.timeout(Math.min(5_000, remaining)));
    }).pipe(Effect.orDie, Effect.interruptible);
};

export const SubscriptionEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    source: Schema.Struct({ type: Schema.String }),
    metadata: Schema.Struct({
      accountId: Schema.String,
      eventSubscriptionId: Schema.String,
      eventTimestamp: Schema.String,
    }),
    payload: Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  }),
);

export type SubscriptionEvent = typeof SubscriptionEvent.Type;

interface SubscriptionEventTarget {
  source: "images" | "kv" | "r2" | "vectorize";
  type: string;
  accountId: string;
  subscriptionId: string;
  identity: string;
}

export interface SubscriptionProbe {
  identity: string;
  createdAt: number;
}

export const hasReadySubscriptionEvent = (
  events: readonly SubscriptionEvent[],
  probes: readonly SubscriptionProbe[],
  expected: Omit<SubscriptionEventTarget, "identity"> & { readyAfter: number },
) =>
  probes.some(
    ({ identity, createdAt }) =>
      createdAt >= expected.readyAfter &&
      events.some((event) => matchesSubscriptionEvent(event, { ...expected, identity })),
  );

export const matchesSubscriptionEvent = (
  event: SubscriptionEvent,
  expected: SubscriptionEventTarget,
) =>
  event.type === `cf.${expected.source}.${expected.type}` &&
  event.source.type === expected.source &&
  event.metadata.accountId === expected.accountId &&
  event.metadata.eventSubscriptionId === expected.subscriptionId &&
  event.payload[expected.source === "kv" || expected.source === "images" ? "id" : "name"] ===
    expected.identity;
