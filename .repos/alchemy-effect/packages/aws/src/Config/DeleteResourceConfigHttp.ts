import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteResourceConfig } from "./DeleteResourceConfig.ts";

export const DeleteResourceConfigHttp = Layer.effect(
  DeleteResourceConfig,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.DeleteResourceConfig",
    operation: config.deleteResourceConfig,
    actions: ["config:DeleteResourceConfig"],
  }),
);
