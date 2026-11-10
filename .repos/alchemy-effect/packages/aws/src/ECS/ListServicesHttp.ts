import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import { ListServices } from "./ListServices.ts";

export const ListServicesHttp = Layer.effect(
  ListServices,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.ListServices",
    operation: ECS.listServices,
    actions: ["ecs:ListServices"],
    // `ecs:ListServices` has no resource-level scoping — grant `*`
    // conditioned on the bound cluster.
    resources: "cluster-condition",
  }),
);
