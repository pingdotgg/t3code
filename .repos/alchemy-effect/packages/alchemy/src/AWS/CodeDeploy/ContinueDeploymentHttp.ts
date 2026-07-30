import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { makeCodeDeployGroupHttpBinding } from "./BindingHttp.ts";
import { ContinueDeployment } from "./ContinueDeployment.ts";

export const ContinueDeploymentHttp = Layer.effect(
  ContinueDeployment,
  makeCodeDeployGroupHttpBinding({
    tag: "AWS.CodeDeploy.ContinueDeployment",
    operation: codedeploy.continueDeployment,
    actions: ["codedeploy:ContinueDeployment"],
  }),
);
