import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `Promote` operation (IAM action `mq:Promote`),
 * scoped to one {@link Broker}.
 *
 * Promotes a cross-region data replication (CRDR) replica broker to the
 * primary role — `SWITCHOVER` performs a coordinated role exchange with the
 * current primary, `FAILOVER` promotes the replica unilaterally when the
 * primary is unreachable. Only meaningful for brokers created with
 * `dataReplicationMode: "CRDR"`. Provide the implementation with
 * `Effect.provide(AWS.MQ.PromoteHttp)`.
 * @binding
 * @section Disaster Recovery
 * @example Fail Over to the Replica
 * ```typescript
 * const promote = yield* MQ.Promote(replica);
 *
 * yield* promote({ Mode: "FAILOVER" });
 * ```
 */
export interface Promote extends Binding.Service<
  Promote,
  "AWS.MQ.Promote",
  (
    broker: Broker,
  ) => Effect.Effect<
    (
      request: Omit<mq.PromoteRequest, "BrokerId">,
    ) => Effect.Effect<mq.PromoteResponse, mq.PromoteError>
  >
> {}
export const Promote = Binding.Service<Promote>("AWS.MQ.Promote");
