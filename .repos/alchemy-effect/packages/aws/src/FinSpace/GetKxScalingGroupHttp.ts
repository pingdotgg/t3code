import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxScalingGroup } from "./GetKxScalingGroup.ts";

export const GetKxScalingGroupHttp = Layer.effect(
  GetKxScalingGroup,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxScalingGroup",
    operation: finspace.getKxScalingGroup,
    actions: ["finspace:GetKxScalingGroup"],
  }),
);
