import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { SimulatePrincipalPolicy } from "./SimulatePrincipalPolicy.ts";

export const SimulatePrincipalPolicyHttp = Layer.effect(
  SimulatePrincipalPolicy,
  makeIamHttpBinding({
    capability: "SimulatePrincipalPolicy",
    iamActions: ["iam:SimulatePrincipalPolicy"],
    operation: iam.simulatePrincipalPolicy,
  }),
);
