import { Effect, Layer, PubSub, Stream } from "effect";

import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusShape,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const makeRuntimeReceiptBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    stream: Stream.fromPubSub(pubSub),
  } satisfies RuntimeReceiptBusShape;
});

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
