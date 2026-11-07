import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { makeCodeDeployGroupHttpBinding } from "./BindingHttp.ts";
import { GetDeploymentTarget } from "./GetDeploymentTarget.ts";

export const GetDeploymentTargetHttp = Layer.effect(
  GetDeploymentTarget,
  makeCodeDeployGroupHttpBinding({
    tag: "AWS.CodeDeploy.GetDeploymentTarget",
    operation: codedeploy.getDeploymentTarget,
    actions: ["codedeploy:GetDeploymentTarget"],
  }),
);
