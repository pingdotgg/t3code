import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Layer from "effect/Layer";
import { makeGroupHttpBinding } from "./BindingHttp.ts";
import { SetInstanceHealth } from "./SetInstanceHealth.ts";

export const SetInstanceHealthHttp = Layer.effect(
  SetInstanceHealth,
  makeGroupHttpBinding({
    tag: "AWS.AutoScaling.SetInstanceHealth",
    operation: autoscaling.setInstanceHealth,
    actions: ["autoscaling:SetInstanceHealth"],
  }),
);
