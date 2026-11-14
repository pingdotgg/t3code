import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import { ListContainerInstances } from "./ListContainerInstances.ts";

export const ListContainerInstancesHttp = Layer.effect(
  ListContainerInstances,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.ListContainerInstances",
    operation: ECS.listContainerInstances,
    actions: ["ecs:ListContainerInstances"],
    // `ecs:ListContainerInstances` authorizes against the cluster.
    resources: ["cluster"],
  }),
);
