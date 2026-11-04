import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { makeCodeDeployGroupHttpBinding } from "./BindingHttp.ts";
import { StopDeployment } from "./StopDeployment.ts";

export const StopDeploymentHttp = Layer.effect(
  StopDeployment,
  makeCodeDeployGroupHttpBinding({
    tag: "AWS.CodeDeploy.StopDeployment",
    operation: codedeploy.stopDeployment,
    actions: ["codedeploy:StopDeployment"],
  }),
);
