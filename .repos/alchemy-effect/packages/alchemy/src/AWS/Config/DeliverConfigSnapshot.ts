import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeliveryChannel } from "./DeliveryChannel.ts";

/**
 * Runtime binding for `config:DeliverConfigSnapshot` — trigger an on-demand
 * delivery of a configuration snapshot to the bound
 * {@link DeliveryChannel}'s S3 bucket; the channel name is injected
 * automatically. Requires a running configuration recorder.
 *
 * Provide `Config.DeliverConfigSnapshotHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Delivering Snapshots
 * @example Deliver a Snapshot On Demand
 * ```typescript
 * // init — grants config:DeliverConfigSnapshot
 * const deliverSnapshot = yield* AWS.Config.DeliverConfigSnapshot(channel);
 *
 * // runtime
 * const result = yield* deliverSnapshot();
 * console.log(result.configSnapshotId);
 * ```
 */
export interface DeliverConfigSnapshot extends Binding.Service<
  DeliverConfigSnapshot,
  "AWS.Config.DeliverConfigSnapshot",
  (
    channel: DeliveryChannel,
  ) => Effect.Effect<
    () => Effect.Effect<
      config.DeliverConfigSnapshotResponse,
      config.DeliverConfigSnapshotError
    >
  >
> {}

export const DeliverConfigSnapshot = Binding.Service<DeliverConfigSnapshot>(
  "AWS.Config.DeliverConfigSnapshot",
);
