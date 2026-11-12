import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Layer from "effect/Layer";
import { makeTargetGroupHttpBinding } from "./BindingHttp.ts";
import { RegisterTargets } from "./RegisterTargets.ts";

export const RegisterTargetsHttp = Layer.effect(
  RegisterTargets,
  makeTargetGroupHttpBinding({
    tag: "AWS.ELBv2.RegisterTargets",
    operation: elbv2.registerTargets,
    actions: ["elasticloadbalancing:RegisterTargets"],
  }),
);
