import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotClientHttpBinding } from "./BindingHttp.ts";
import { ListSubscriptions } from "./ListSubscriptions.ts";

/**
 * HTTP implementation of the {@link ListSubscriptions} capability — grants
 * `iot:ListSubscriptions` on the bound client filter and calls the IoT
 * data-plane `ListSubscriptions` API.
 */
export const ListSubscriptionsHttp = Layer.effect(
  ListSubscriptions,
  makeIotClientHttpBinding({
    tag: "AWS.IoT.ListSubscriptions",
    operation: iotdata.listSubscriptions,
    actions: ["iot:ListSubscriptions"],
  }),
);
