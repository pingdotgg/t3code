import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `RebootBroker` operation (IAM action
 * `mq:RebootBroker`), scoped to one {@link Broker}.
 *
 * Reboots the broker to apply pending modifications (engine version,
 * host instance type, configuration revision, user changes). The reboot is
 * asynchronous — the broker transitions through `REBOOT_IN_PROGRESS` back to
 * `RUNNING`. Provide the implementation with
 * `Effect.provide(AWS.MQ.RebootBrokerHttp)`.
 * @binding
 * @section Managing a Broker
 * @example Apply Pending Changes with a Reboot
 * ```typescript
 * const rebootBroker = yield* MQ.RebootBroker(broker);
 *
 * yield* rebootBroker();
 * ```
 */
export interface RebootBroker extends Binding.Service<
  RebootBroker,
  "AWS.MQ.RebootBroker",
  (
    broker: Broker,
  ) => Effect.Effect<
    () => Effect.Effect<mq.RebootBrokerResponse, mq.RebootBrokerError>
  >
> {}
export const RebootBroker = Binding.Service<RebootBroker>(
  "AWS.MQ.RebootBroker",
);
