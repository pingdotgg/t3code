import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSAccountHttpBinding } from "./BindingHttp.ts";
import { ListAccessPolicies } from "./ListAccessPolicies.ts";

export const ListAccessPoliciesHttp = Layer.effect(
  ListAccessPolicies,
  makeEKSAccountHttpBinding({
    tag: "AWS.EKS.ListAccessPolicies",
    operation: eks.listAccessPolicies,
    actions: ["eks:ListAccessPolicies"],
  }),
);
