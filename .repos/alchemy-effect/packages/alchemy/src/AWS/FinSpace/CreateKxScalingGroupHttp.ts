import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { CreateKxScalingGroup } from "./CreateKxScalingGroup.ts";

export const CreateKxScalingGroupHttp = Layer.effect(
  CreateKxScalingGroup,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.CreateKxScalingGroup",
    operation: finspace.createKxScalingGroup,
    actions: ["finspace:CreateKxScalingGroup"],
  }),
);
