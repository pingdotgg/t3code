import type * as Firehose from "@distilled.cloud/aws/firehose";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListDeliveryStreamsRequest
  extends Firehose.ListDeliveryStreamsInput {}

/**
 * Runtime binding for `firehose:ListDeliveryStreams`.
 *
 * An account-level binding — call it with no arguments to get a callable
 * that lists delivery stream names in the region (paged via
 * `ExclusiveStartDeliveryStreamName` + `HasMoreDeliveryStreams`). Provide
 * the `ListDeliveryStreamsHttp` layer on the Function to satisfy the
 * binding.
 * @binding
 * @section Stream Metadata
 * @example List Delivery Streams in the Region
 * ```typescript
 * const listDeliveryStreams = yield* AWS.Firehose.ListDeliveryStreams();
 *
 * const response = yield* listDeliveryStreams();
 * const names = response.DeliveryStreamNames;
 * ```
 */
export interface ListDeliveryStreams extends Binding.Service<
  ListDeliveryStreams,
  "AWS.Firehose.ListDeliveryStreams",
  () => Effect.Effect<
    (
      request?: ListDeliveryStreamsRequest,
    ) => Effect.Effect<
      Firehose.ListDeliveryStreamsOutput,
      Firehose.ListDeliveryStreamsError
    >
  >
> {}

export const ListDeliveryStreams = Binding.Service<ListDeliveryStreams>(
  "AWS.Firehose.ListDeliveryStreams",
);
