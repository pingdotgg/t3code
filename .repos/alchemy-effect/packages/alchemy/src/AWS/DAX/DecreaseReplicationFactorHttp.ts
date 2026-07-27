import * as dax from "@distilled.cloud/aws/dax";
import * as Layer from "effect/Layer";
import { makeDaxClusterHttpBinding } from "./BindingHttp.ts";
import { DecreaseReplicationFactor } from "./DecreaseReplicationFactor.ts";

export const DecreaseReplicationFactorHttp = Layer.effect(
  DecreaseReplicationFactor,
  makeDaxClusterHttpBinding({
    tag: "AWS.DAX.DecreaseReplicationFactor",
    operation: dax.decreaseReplicationFactor,
    actions: ["dax:DecreaseReplicationFactor"],
  }),
);
