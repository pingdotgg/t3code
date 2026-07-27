import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `DescribeBroker` operation (IAM action
 * `mq:DescribeBroker`), scoped to one {@link Broker}.
 *
 * Resolves the broker's live state at runtime — engine version, instance
 * endpoints (the wire-protocol URIs clients connect to), pending changes,
 * and maintenance information. Provide the implementation with
 * `Effect.provide(AWS.MQ.DescribeBrokerHttp)`.
 * @binding
 * @section Observing a Broker
 * @example Resolve the Broker's Endpoints
 * ```typescript
 * const describeBroker = yield* MQ.DescribeBroker(broker);
 *
 * const info = yield* describeBroker();
 * // info.BrokerState → "RUNNING"
 * // info.BrokerInstances?.[0]?.Endpoints → ["ssl://b-….mq.us-west-2.amazonaws.com:61617", …]
 * ```
 */
export interface DescribeBroker extends Binding.Service<
  DescribeBroker,
  "AWS.MQ.DescribeBroker",
  (
    broker: Broker,
  ) => Effect.Effect<
    () => Effect.Effect<mq.DescribeBrokerResponse, mq.DescribeBrokerError>
  >
> {}
export const DescribeBroker = Binding.Service<DescribeBroker>(
  "AWS.MQ.DescribeBroker",
);
