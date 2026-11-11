import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { BatchGetDeploymentTargets } from "./BatchGetDeploymentTargets.ts";
import { makeCodeDeployGroupHttpBinding } from "./BindingHttp.ts";

export const BatchGetDeploymentTargetsHttp = Layer.effect(
  BatchGetDeploymentTargets,
  makeCodeDeployGroupHttpBinding({
    tag: "AWS.CodeDeploy.BatchGetDeploymentTargets",
    operation: codedeploy.batchGetDeploymentTargets,
    actions: ["codedeploy:BatchGetDeploymentTargets"],
  }),
);
