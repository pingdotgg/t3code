import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { makeCodeDeployGroupNameHttpBinding } from "./BindingHttp.ts";
import { ListDeployments } from "./ListDeployments.ts";

export const ListDeploymentsHttp = Layer.effect(
  ListDeployments,
  makeCodeDeployGroupNameHttpBinding({
    tag: "AWS.CodeDeploy.ListDeployments",
    operation: codedeploy.listDeployments,
    actions: ["codedeploy:ListDeployments"],
  }),
);
