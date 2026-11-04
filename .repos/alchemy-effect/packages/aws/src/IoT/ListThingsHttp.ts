import * as iot from "@distilled.cloud/aws/iot";
import * as Layer from "effect/Layer";
import { makeIotAccountHttpBinding } from "./BindingHttp.ts";
import { ListThings } from "./ListThings.ts";

/**
 * HTTP implementation of the {@link ListThings} capability — grants
 * `iot:ListThings` on `*` and calls the IoT `ListThings` API.
 */
export const ListThingsHttp = Layer.effect(
  ListThings,
  makeIotAccountHttpBinding({
    tag: "AWS.IoT.ListThings",
    operation: iot.listThings,
    actions: ["iot:ListThings"],
  }),
);
