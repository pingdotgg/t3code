import { Effect, Layer, PubSub, Stream } from "effect";

import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusShape,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const makeRuntimeReceiptBus = Effect.succeed({
  publish: () => Effect.void,
  stream: Stream.empty,
} satisfies RuntimeReceiptBusShape);

const makeRuntimeReceiptBusTest = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    get stream() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies RuntimeReceiptBusShape;
});

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
export const RuntimeReceiptBusTestLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBusTest);
