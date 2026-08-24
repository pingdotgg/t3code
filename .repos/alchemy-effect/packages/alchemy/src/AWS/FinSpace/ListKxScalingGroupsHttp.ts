import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { ListKxScalingGroups } from "./ListKxScalingGroups.ts";

export const ListKxScalingGroupsHttp = Layer.effect(
  ListKxScalingGroups,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxScalingGroups",
    operation: finspace.listKxScalingGroups,
    actions: ["finspace:ListKxScalingGroups"],
  }),
);
