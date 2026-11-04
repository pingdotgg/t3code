import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { makeCodeDeployGroupHttpBinding } from "./BindingHttp.ts";
import { ListDeploymentTargets } from "./ListDeploymentTargets.ts";

export const ListDeploymentTargetsHttp = Layer.effect(
  ListDeploymentTargets,
  makeCodeDeployGroupHttpBinding({
    tag: "AWS.CodeDeploy.ListDeploymentTargets",
    operation: codedeploy.listDeploymentTargets,
    actions: ["codedeploy:ListDeploymentTargets"],
  }),
);
