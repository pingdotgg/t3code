import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsServiceHttpBinding } from "./BindingHttp.ts";
import { ListServiceDeployments } from "./ListServiceDeployments.ts";

export const ListServiceDeploymentsHttp = Layer.effect(
  ListServiceDeployments,
  makeEcsServiceHttpBinding({
    tag: "AWS.ECS.ListServiceDeployments",
    operation: ECS.listServiceDeployments,
    actions: ["ecs:ListServiceDeployments"],
    // `ecs:ListServiceDeployments` authorizes against the service itself.
    resources: ["service"],
    inject: true,
  }),
);
