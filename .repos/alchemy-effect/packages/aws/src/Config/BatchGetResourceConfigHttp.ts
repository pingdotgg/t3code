import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { BatchGetResourceConfig } from "./BatchGetResourceConfig.ts";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";

export const BatchGetResourceConfigHttp = Layer.effect(
  BatchGetResourceConfig,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.BatchGetResourceConfig",
    operation: config.batchGetResourceConfig,
    actions: ["config:BatchGetResourceConfig"],
  }),
);
