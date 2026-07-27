import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { StartResourceEvaluation } from "./StartResourceEvaluation.ts";

export const StartResourceEvaluationHttp = Layer.effect(
  StartResourceEvaluation,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.StartResourceEvaluation",
    operation: config.startResourceEvaluation,
    // cloudformation:DescribeType is a dependent action: Config validates
    // the CFN_RESOURCE_SCHEMA resource type schema with the CALLER's
    // permissions and rejects with AccessDeniedException without it
    // (observed live; see the StartResourceEvaluation API reference).
    actions: ["config:StartResourceEvaluation", "cloudformation:DescribeType"],
  }),
);
