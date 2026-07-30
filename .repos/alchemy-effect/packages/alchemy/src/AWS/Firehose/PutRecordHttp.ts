import * as Firehose from "@distilled.cloud/aws/firehose";
import * as Layer from "effect/Layer";
import { makeDeliveryStreamHttpBinding } from "./BindingHttp.ts";
import { PutRecord } from "./PutRecord.ts";

/**
 * HTTP implementation of {@link PutRecord}. At deploy time it grants
 * `firehose:PutRecord` on the bound delivery stream; at runtime it calls the
 * Firehose API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const PutRecordHttp = Layer.effect(
  PutRecord,
  makeDeliveryStreamHttpBinding({
    tag: "AWS.Firehose.PutRecord",
    operation: Firehose.putRecord,
    actions: ["firehose:PutRecord"],
  }),
);
