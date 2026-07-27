import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigResourceHttpBinding } from "./BindingHttp.ts";
import type { DeliveryChannel } from "./DeliveryChannel.ts";
import { DeliverConfigSnapshot } from "./DeliverConfigSnapshot.ts";

export const DeliverConfigSnapshotHttp = Layer.effect(
  DeliverConfigSnapshot,
  makeConfigResourceHttpBinding({
    tag: "AWS.Config.DeliverConfigSnapshot",
    operation: config.deliverConfigSnapshot,
    actions: ["config:DeliverConfigSnapshot"],
    requestKey: "deliveryChannelName",
    identifier: (channel: DeliveryChannel) => channel.deliveryChannelName,
  }),
);
