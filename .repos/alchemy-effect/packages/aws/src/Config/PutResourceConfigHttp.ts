import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { PutResourceConfig } from "./PutResourceConfig.ts";

export const PutResourceConfigHttp = Layer.effect(
  PutResourceConfig,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.PutResourceConfig",
    operation: config.putResourceConfig,
    actions: ["config:PutResourceConfig"],
  }),
);
