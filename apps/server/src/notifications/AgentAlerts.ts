import type { AgentAlert } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ClaudePushChannels } from "../orchestration-v2/Adapters/claudePushNotification.ts";

export interface AgentAlertPhoneDelivery {
  readonly publish: (alert: AgentAlert) => Effect.Effect<boolean>;
}

export class AgentAlerts extends Context.Service<
  AgentAlerts,
  {
    readonly offer: (alert: AgentAlert) => Effect.Effect<ClaudePushChannels>;
    readonly stream: Stream.Stream<AgentAlert>;
    readonly registerPhone: (delivery: AgentAlertPhoneDelivery) => Effect.Effect<void>;
  }
>()("t3/notifications/AgentAlerts") {}

const make = Effect.gen(function* () {
  const subscribers = yield* Ref.make(0);
  const alerts = yield* PubSub.unbounded<AgentAlert>();
  const phone = yield* Ref.make<AgentAlertPhoneDelivery | null>(null);

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe first. Counting before the subscription exists tells Claude the
      // alert was sent in a window where publish has nobody to deliver to.
      const subscription = yield* PubSub.subscribe(alerts);
      yield* Ref.update(subscribers, (count) => count + 1);
      yield* Effect.addFinalizer(() =>
        Ref.update(subscribers, (count) => (count > 0 ? count - 1 : 0)),
      );
      return Stream.fromSubscription(subscription);
    }),
  );

  const offer: AgentAlerts["Service"]["offer"] = Effect.fn("AgentAlerts.offer")(function* (alert) {
    const delivery = yield* Ref.get(phone);
    const local = (yield* Ref.get(subscribers)) > 0;
    if (local) yield* PubSub.publish(alerts, alert);
    const phoneAccepted =
      delivery === null
        ? false
        : yield* delivery
            .publish(alert)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("agent alert phone delivery failed", { cause }).pipe(
                  Effect.as(false),
                ),
              ),
            );
    return { local, phone: phoneAccepted };
  });

  return AgentAlerts.of({
    offer,
    stream,
    registerPhone: Effect.fn("AgentAlerts.registerPhone")((delivery) => Ref.set(phone, delivery)),
  });
});

export const layer = Layer.effect(AgentAlerts, make);
