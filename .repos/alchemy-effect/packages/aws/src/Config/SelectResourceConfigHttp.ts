import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { SelectResourceConfig } from "./SelectResourceConfig.ts";

export const SelectResourceConfigHttp = Layer.effect(
  SelectResourceConfig,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.SelectResourceConfig",
    operation: config.selectResourceConfig,
    actions: ["config:SelectResourceConfig"],
  }),
);
