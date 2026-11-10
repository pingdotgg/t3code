import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsServiceHttpBinding } from "./BindingHttp.ts";
import { DescribeServiceRevisions } from "./DescribeServiceRevisions.ts";

export const DescribeServiceRevisionsHttp = Layer.effect(
  DescribeServiceRevisions,
  makeEcsServiceHttpBinding({
    tag: "AWS.ECS.DescribeServiceRevisions",
    operation: ECS.describeServiceRevisions,
    actions: ["ecs:DescribeServiceRevisions"],
    // Authorizes against the service-revision resource:
    // arn:aws:ecs:{region}:{account}:service-revision/{cluster}/{service}/*
    resources: ["service-revision"],
  }),
);
