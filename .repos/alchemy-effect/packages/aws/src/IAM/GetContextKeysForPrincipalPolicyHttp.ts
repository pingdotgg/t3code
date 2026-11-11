import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GetContextKeysForPrincipalPolicy } from "./GetContextKeysForPrincipalPolicy.ts";

export const GetContextKeysForPrincipalPolicyHttp = Layer.effect(
  GetContextKeysForPrincipalPolicy,
  makeIamHttpBinding({
    capability: "GetContextKeysForPrincipalPolicy",
    iamActions: ["iam:GetContextKeysForPrincipalPolicy"],
    operation: iam.getContextKeysForPrincipalPolicy,
  }),
);
