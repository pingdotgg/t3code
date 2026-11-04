import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { GetResourcePolicies } from "./GetResourcePolicies.ts";

export const GetResourcePoliciesHttp = Layer.effect(
  GetResourcePolicies,
  makeRAMHttpBinding({
    capability: "GetResourcePolicies",
    iamActions: ["ram:GetResourcePolicies"],
    operation: ram.getResourcePolicies,
  }),
);
