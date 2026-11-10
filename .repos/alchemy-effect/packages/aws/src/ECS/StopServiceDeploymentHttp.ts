import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsServiceHttpBinding } from "./BindingHttp.ts";
import { StopServiceDeployment } from "./StopServiceDeployment.ts";

export const StopServiceDeploymentHttp = Layer.effect(
  StopServiceDeployment,
  makeEcsServiceHttpBinding({
    tag: "AWS.ECS.StopServiceDeployment",
    operation: ECS.stopServiceDeployment,
    actions: ["ecs:StopServiceDeployment"],
    // Authorizes against the service-deployment resource:
    // arn:aws:ecs:{region}:{account}:service-deployment/{cluster}/{service}/*
    resources: ["service-deployment"],
  }),
);
