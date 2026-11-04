import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { DeleteKxScalingGroup } from "./DeleteKxScalingGroup.ts";

export const DeleteKxScalingGroupHttp = Layer.effect(
  DeleteKxScalingGroup,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.DeleteKxScalingGroup",
    operation: finspace.deleteKxScalingGroup,
    actions: ["finspace:DeleteKxScalingGroup"],
  }),
);
