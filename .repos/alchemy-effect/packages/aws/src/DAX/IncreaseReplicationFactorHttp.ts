import * as dax from "@distilled.cloud/aws/dax";
import * as Layer from "effect/Layer";
import { makeDaxClusterHttpBinding } from "./BindingHttp.ts";
import { IncreaseReplicationFactor } from "./IncreaseReplicationFactor.ts";

export const IncreaseReplicationFactorHttp = Layer.effect(
  IncreaseReplicationFactor,
  makeDaxClusterHttpBinding({
    tag: "AWS.DAX.IncreaseReplicationFactor",
    operation: dax.increaseReplicationFactor,
    actions: ["dax:IncreaseReplicationFactor"],
  }),
);
