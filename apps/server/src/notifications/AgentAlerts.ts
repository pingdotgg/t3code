import type { AgentAlert } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export class AgentAlerts extends Context.Service<
  AgentAlerts,
  {
    /**
     * Hands the alert to every subscribed client. False when none is subscribed. True means a
     * client took it, not that it put it on screen.
     */
    readonly offer: (alert: AgentAlert) => Effect.Effect<boolean>;
    readonly stream: Stream.Stream<AgentAlert>;
  }
>()("t3/notifications/AgentAlerts") {}

const make = Effect.gen(function* () {
  const subscribers = yield* Ref.make(0);
  const alerts = yield* PubSub.unbounded<AgentAlert>();

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before counting: counted first, an offer in between reports a
      // delivery that the subscription never receives.
      const subscription = yield* PubSub.subscribe(alerts);
      // One step, so an interrupt cannot leave the count raised with no cleanup registered.
      yield* Effect.acquireRelease(
        Ref.update(subscribers, (count) => count + 1),
        () => Ref.update(subscribers, (count) => count - 1),
      );
      return Stream.fromSubscription(subscription);
    }),
  );

  const offer: AgentAlerts["Service"]["offer"] = Effect.fn("AgentAlerts.offer")(function* (alert) {
    if ((yield* Ref.get(subscribers)) === 0) return false;
    yield* PubSub.publish(alerts, alert);
    return true;
  });

  return AgentAlerts.of({ offer, stream });
});

export const layer = Layer.effect(AgentAlerts, make);
