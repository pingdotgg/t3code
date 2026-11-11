import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53HealthCheckHttpBinding } from "./BindingHttp.ts";
import { GetHealthCheckLastFailureReason } from "./GetHealthCheckLastFailureReason.ts";

export const GetHealthCheckLastFailureReasonHttp = Layer.effect(
  GetHealthCheckLastFailureReason,
  makeRoute53HealthCheckHttpBinding({
    tag: "AWS.Route53.GetHealthCheckLastFailureReason",
    operation: route53.getHealthCheckLastFailureReason,
    actions: ["route53:GetHealthCheckLastFailureReason"],
  }),
);
