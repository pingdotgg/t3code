import * as Firehose from "@distilled.cloud/aws/firehose";
import * as Layer from "effect/Layer";
import { makeFirehoseAccountHttpBinding } from "./BindingHttp.ts";
import { ListDeliveryStreams } from "./ListDeliveryStreams.ts";

/**
 * HTTP implementation of {@link ListDeliveryStreams}. At deploy time it
 * grants `firehose:ListDeliveryStreams` on `*` (the action does not support
 * resource-level permissions); at runtime it calls the Firehose API with the
 * host Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListDeliveryStreamsHttp = Layer.effect(
  ListDeliveryStreams,
  makeFirehoseAccountHttpBinding({
    tag: "AWS.Firehose.ListDeliveryStreams",
    operation: Firehose.listDeliveryStreams,
    actions: ["firehose:ListDeliveryStreams"],
  }),
);
