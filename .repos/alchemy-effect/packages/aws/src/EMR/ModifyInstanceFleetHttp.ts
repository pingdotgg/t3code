import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { ModifyInstanceFleet } from "./ModifyInstanceFleet.ts";

export const ModifyInstanceFleetHttp = Layer.effect(
  ModifyInstanceFleet,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ModifyInstanceFleet",
    operation: emr.modifyInstanceFleet,
    actions: ["elasticmapreduce:ModifyInstanceFleet"],
  }),
);
