import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { CancelSteps } from "./CancelSteps.ts";

export const CancelStepsHttp = Layer.effect(
  CancelSteps,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.CancelSteps",
    operation: emr.cancelSteps,
    actions: ["elasticmapreduce:CancelSteps"],
  }),
);
