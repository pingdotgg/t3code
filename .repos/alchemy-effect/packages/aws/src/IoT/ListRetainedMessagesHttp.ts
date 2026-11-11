import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotAccountHttpBinding } from "./BindingHttp.ts";
import { ListRetainedMessages } from "./ListRetainedMessages.ts";

/**
 * HTTP implementation of the {@link ListRetainedMessages} capability —
 * grants `iot:ListRetainedMessages` on `*` and calls the IoT data-plane
 * `ListRetainedMessages` API.
 */
export const ListRetainedMessagesHttp = Layer.effect(
  ListRetainedMessages,
  makeIotAccountHttpBinding({
    tag: "AWS.IoT.ListRetainedMessages",
    operation: iotdata.listRetainedMessages,
    actions: ["iot:ListRetainedMessages"],
  }),
);
