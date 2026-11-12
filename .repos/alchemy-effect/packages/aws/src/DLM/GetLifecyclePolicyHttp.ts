import * as dlm from "@distilled.cloud/aws/dlm";
import * as Layer from "effect/Layer";
import { makeDlmPolicyHttpBinding } from "./BindingHttp.ts";
import { GetLifecyclePolicy } from "./GetLifecyclePolicy.ts";

export const GetLifecyclePolicyHttp = Layer.effect(
  GetLifecyclePolicy,
  makeDlmPolicyHttpBinding({
    tag: "AWS.DLM.GetLifecyclePolicy",
    operation: dlm.getLifecyclePolicy,
    actions: ["dlm:GetLifecyclePolicy"],
  }),
);
