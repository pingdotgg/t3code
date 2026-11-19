import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GetContextKeysForCustomPolicy } from "./GetContextKeysForCustomPolicy.ts";

export const GetContextKeysForCustomPolicyHttp = Layer.effect(
  GetContextKeysForCustomPolicy,
  makeIamHttpBinding({
    capability: "GetContextKeysForCustomPolicy",
    iamActions: ["iam:GetContextKeysForCustomPolicy"],
    operation: iam.getContextKeysForCustomPolicy,
  }),
);
