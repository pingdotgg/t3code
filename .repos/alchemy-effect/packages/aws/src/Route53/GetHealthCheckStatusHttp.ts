import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53HealthCheckHttpBinding } from "./BindingHttp.ts";
import { GetHealthCheckStatus } from "./GetHealthCheckStatus.ts";

export const GetHealthCheckStatusHttp = Layer.effect(
  GetHealthCheckStatus,
  makeRoute53HealthCheckHttpBinding({
    tag: "AWS.Route53.GetHealthCheckStatus",
    operation: route53.getHealthCheckStatus,
    actions: ["route53:GetHealthCheckStatus"],
  }),
);
