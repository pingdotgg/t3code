import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsServiceHttpBinding } from "./BindingHttp.ts";
import { ContinueServiceDeployment } from "./ContinueServiceDeployment.ts";

export const ContinueServiceDeploymentHttp = Layer.effect(
  ContinueServiceDeployment,
  makeEcsServiceHttpBinding({
    tag: "AWS.ECS.ContinueServiceDeployment",
    operation: ECS.continueServiceDeployment,
    actions: ["ecs:ContinueServiceDeployment"],
    // Authorizes against the service-deployment resource:
    // arn:aws:ecs:{region}:{account}:service-deployment/{cluster}/{service}/*
    resources: ["service-deployment"],
  }),
);
