import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeServices } from "./DescribeServices.ts";

export const DescribeServicesHttp = Layer.effect(
  DescribeServices,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.DescribeServices",
    operation: ECS.describeServices,
    actions: ["ecs:DescribeServices"],
    // `ecs:DescribeServices` authorizes against the service resource:
    // arn:aws:ecs:{region}:{account}:service/{clusterName}/*
    resources: ["service"],
  }),
);
