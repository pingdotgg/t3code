import * as Firehose from "@distilled.cloud/aws/firehose";
import * as Layer from "effect/Layer";
import { makeDeliveryStreamHttpBinding } from "./BindingHttp.ts";
import { PutRecordBatch } from "./PutRecordBatch.ts";

/**
 * HTTP implementation of {@link PutRecordBatch}. At deploy time it grants
 * `firehose:PutRecordBatch` on the bound delivery stream; at runtime it calls
 * the Firehose API with the host Function's credentials. Provide this layer
 * on the Function using the binding.
 */
export const PutRecordBatchHttp = Layer.effect(
  PutRecordBatch,
  makeDeliveryStreamHttpBinding({
    tag: "AWS.Firehose.PutRecordBatch",
    operation: Firehose.putRecordBatch,
    actions: ["firehose:PutRecordBatch"],
  }),
);
