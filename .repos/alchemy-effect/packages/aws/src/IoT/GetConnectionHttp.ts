import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotClientHttpBinding } from "./BindingHttp.ts";
import { GetConnection } from "./GetConnection.ts";

/**
 * HTTP implementation of the {@link GetConnection} capability — grants
 * `iot:GetConnection` on the bound client filter and calls the IoT
 * data-plane `GetConnection` API.
 */
export const GetConnectionHttp = Layer.effect(
  GetConnection,
  makeIotClientHttpBinding({
    tag: "AWS.IoT.GetConnection",
    operation: iotdata.getConnection,
    actions: ["iot:GetConnection"],
  }),
);
