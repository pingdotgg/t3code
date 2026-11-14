import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import { GetTaskProtection } from "./GetTaskProtection.ts";

export const GetTaskProtectionHttp = Layer.effect(
  GetTaskProtection,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.GetTaskProtection",
    operation: ECS.getTaskProtection,
    actions: ["ecs:GetTaskProtection"],
    // Authorizes against the task resource:
    // arn:aws:ecs:{region}:{account}:task/{clusterName}/*
    resources: ["task"],
  }),
);
