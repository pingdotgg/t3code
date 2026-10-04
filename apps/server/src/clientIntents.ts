import type {
  ClientIntent,
  ClientIntentThreadPanel,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";

/**
 * Broadcasts requests for connected clients to show something. Each intent
 * names the desktop the user focused last, from the focus reports desktops
 * already send for preview automation, so an agent driven from a terminal
 * still reaches it. Clients without a target fall back to whichever is focused.
 */
export class ClientIntents extends Context.Service<
  ClientIntents,
  {
    /** Resolves whether any client was subscribed to receive the request. */
    readonly openThread: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly panel?: ClientIntentThreadPanel;
    }) => Effect.Effect<boolean>;
    readonly stream: Stream.Stream<ClientIntent>;
  }
>()("t3/clientIntents") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const pubsub = yield* PubSub.unbounded<ClientIntent>();
  const subscribers = yield* Ref.make(0);

  return ClientIntents.of({
    openThread: (input) =>
      Effect.gen(function* () {
        const intentId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const targetClientId = yield* broker.lastFocusedClientId(input.environmentId);
        yield* PubSub.publish(pubsub, {
          type: "openThread",
          intentId,
          ...input,
          ...(targetClientId === undefined ? {} : { targetClientId }),
        });
        return (yield* Ref.get(subscribers)) > 0;
      }),
    stream: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(pubsub);
        yield* Effect.acquireRelease(
          Ref.update(subscribers, (count) => count + 1),
          () => Ref.update(subscribers, (count) => count - 1),
        );
        return Stream.fromSubscription(subscription);
      }),
    ),
  });
});

export const layer = Layer.effect(ClientIntents, make);
