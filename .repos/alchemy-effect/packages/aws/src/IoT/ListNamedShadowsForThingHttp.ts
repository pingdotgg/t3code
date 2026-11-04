import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotThingHttpBinding } from "./BindingHttp.ts";
import { ListNamedShadowsForThing } from "./ListNamedShadowsForThing.ts";

/**
 * HTTP implementation of the {@link ListNamedShadowsForThing} capability —
 * grants `iot:ListNamedShadowsForThing` on the thing ARN and calls the IoT
 * data-plane `ListNamedShadowsForThing` API.
 */
export const ListNamedShadowsForThingHttp = Layer.effect(
  ListNamedShadowsForThing,
  makeIotThingHttpBinding({
    tag: "AWS.IoT.ListNamedShadowsForThing",
    operation: iotdata.listNamedShadowsForThing,
    actions: ["iot:ListNamedShadowsForThing"],
  }),
);
