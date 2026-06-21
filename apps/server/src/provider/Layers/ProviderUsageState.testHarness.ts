import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageStateLive } from "./ProviderUsageState.ts";

export function makeProviderUsageStateTestHarness() {
  const pubsub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const providerServiceLayer = Layer.succeed(ProviderService, {
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    streamEvents: Stream.fromPubSub(pubsub),
  });

  return {
    pubsub,
    layer: ProviderUsageStateLive.pipe(Layer.provide(providerServiceLayer)),
  };
}
