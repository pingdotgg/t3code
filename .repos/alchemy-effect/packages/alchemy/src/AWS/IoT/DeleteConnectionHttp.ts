import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotClientHttpBinding } from "./BindingHttp.ts";
import { DeleteConnection } from "./DeleteConnection.ts";

/**
 * HTTP implementation of the {@link DeleteConnection} capability — grants
 * `iot:DeleteConnection` on the bound client filter and calls the IoT
 * data-plane `DeleteConnection` API.
 */
export const DeleteConnectionHttp = Layer.effect(
  DeleteConnection,
  makeIotClientHttpBinding({
    tag: "AWS.IoT.DeleteConnection",
    operation: iotdata.deleteConnection,
    actions: ["iot:DeleteConnection"],
  }),
);
