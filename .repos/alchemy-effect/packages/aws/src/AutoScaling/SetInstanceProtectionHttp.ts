import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Layer from "effect/Layer";
import { makeGroupHttpBinding } from "./BindingHttp.ts";
import { SetInstanceProtection } from "./SetInstanceProtection.ts";

export const SetInstanceProtectionHttp = Layer.effect(
  SetInstanceProtection,
  makeGroupHttpBinding({
    tag: "AWS.AutoScaling.SetInstanceProtection",
    operation: autoscaling.setInstanceProtection,
    actions: ["autoscaling:SetInstanceProtection"],
  }),
);
