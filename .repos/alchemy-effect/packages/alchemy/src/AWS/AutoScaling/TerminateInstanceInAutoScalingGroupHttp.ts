import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Layer from "effect/Layer";
import { makeGroupHttpBinding } from "./BindingHttp.ts";
import { TerminateInstanceInAutoScalingGroup } from "./TerminateInstanceInAutoScalingGroup.ts";

export const TerminateInstanceInAutoScalingGroupHttp = Layer.effect(
  TerminateInstanceInAutoScalingGroup,
  makeGroupHttpBinding({
    tag: "AWS.AutoScaling.TerminateInstanceInAutoScalingGroup",
    operation: autoscaling.terminateInstanceInAutoScalingGroup,
    actions: ["autoscaling:TerminateInstanceInAutoScalingGroup"],
  }),
);
