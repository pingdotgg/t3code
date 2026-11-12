import * as dlm from "@distilled.cloud/aws/dlm";
import * as Layer from "effect/Layer";
import { makeDlmAccountHttpBinding } from "./BindingHttp.ts";
import { GetLifecyclePolicies } from "./GetLifecyclePolicies.ts";

export const GetLifecyclePoliciesHttp = Layer.effect(
  GetLifecyclePolicies,
  makeDlmAccountHttpBinding({
    tag: "AWS.DLM.GetLifecyclePolicies",
    operation: dlm.getLifecyclePolicies,
    actions: ["dlm:GetLifecyclePolicies"],
  }),
);
