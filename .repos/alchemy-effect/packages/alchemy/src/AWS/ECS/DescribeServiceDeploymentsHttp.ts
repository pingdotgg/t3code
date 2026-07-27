import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsServiceHttpBinding } from "./BindingHttp.ts";
import { DescribeServiceDeployments } from "./DescribeServiceDeployments.ts";

export const DescribeServiceDeploymentsHttp = Layer.effect(
  DescribeServiceDeployments,
  makeEcsServiceHttpBinding({
    tag: "AWS.ECS.DescribeServiceDeployments",
    operation: ECS.describeServiceDeployments,
    actions: ["ecs:DescribeServiceDeployments"],
    // Authorizes against the service-deployment resource:
    // arn:aws:ecs:{region}:{account}:service-deployment/{cluster}/{service}/*
    resources: ["service-deployment"],
  }),
);
