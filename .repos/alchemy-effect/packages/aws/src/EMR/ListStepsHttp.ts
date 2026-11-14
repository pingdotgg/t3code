import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { ListSteps } from "./ListSteps.ts";

export const ListStepsHttp = Layer.effect(
  ListSteps,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ListSteps",
    operation: emr.listSteps,
    actions: ["elasticmapreduce:ListSteps"],
  }),
);
