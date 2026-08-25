import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Layer from "effect/Layer";
import { makeGroupHttpBinding } from "./BindingHttp.ts";
import { SetDesiredCapacity } from "./SetDesiredCapacity.ts";

export const SetDesiredCapacityHttp = Layer.effect(
  SetDesiredCapacity,
  makeGroupHttpBinding({
    tag: "AWS.AutoScaling.SetDesiredCapacity",
    operation: autoscaling.setDesiredCapacity,
    actions: ["autoscaling:SetDesiredCapacity"],
  }),
);
