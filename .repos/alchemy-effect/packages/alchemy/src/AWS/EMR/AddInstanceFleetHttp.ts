import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { AddInstanceFleet } from "./AddInstanceFleet.ts";

export const AddInstanceFleetHttp = Layer.effect(
  AddInstanceFleet,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.AddInstanceFleet",
    operation: emr.addInstanceFleet,
    actions: ["elasticmapreduce:AddInstanceFleet"],
  }),
);
