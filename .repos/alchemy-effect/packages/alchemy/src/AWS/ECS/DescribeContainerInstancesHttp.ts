import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeContainerInstances } from "./DescribeContainerInstances.ts";

export const DescribeContainerInstancesHttp = Layer.effect(
  DescribeContainerInstances,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.DescribeContainerInstances",
    operation: ECS.describeContainerInstances,
    actions: ["ecs:DescribeContainerInstances"],
    // Authorizes against the container-instance resource:
    // arn:aws:ecs:{region}:{account}:container-instance/{clusterName}/*
    resources: ["container-instance"],
  }),
);
