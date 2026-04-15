/**
 * RuntimeReceiptBus layers.
 *
 * `RuntimeReceiptBusLive` is the production default and intentionally does not
 * retain or broadcast receipts. `RuntimeReceiptBusTest` installs the in-memory
 * PubSub-backed implementation used by integration tests that need to await
 * checkpoint-reactor milestones precisely.
 *
 * @module RuntimeReceiptBus
 */
import { Effect, Layer, PubSub, Stream } from "effect";

import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusShape,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const makeRuntimeReceiptBus = Effect.succeed({
  publish: () => Effect.void,
  streamEventsForTest: Stream.empty,
} satisfies RuntimeReceiptBusShape);

const makeRuntimeReceiptBusTest = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    get streamEventsForTest() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies RuntimeReceiptBusShape;
});

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
export const RuntimeReceiptBusTest = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBusTest);
