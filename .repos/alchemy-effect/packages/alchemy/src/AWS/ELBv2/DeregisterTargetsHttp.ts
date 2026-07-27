import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Layer from "effect/Layer";
import { makeTargetGroupHttpBinding } from "./BindingHttp.ts";
import { DeregisterTargets } from "./DeregisterTargets.ts";

export const DeregisterTargetsHttp = Layer.effect(
  DeregisterTargets,
  makeTargetGroupHttpBinding({
    tag: "AWS.ELBv2.DeregisterTargets",
    operation: elbv2.deregisterTargets,
    actions: ["elasticloadbalancing:DeregisterTargets"],
  }),
);
