import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { SimulateCustomPolicy } from "./SimulateCustomPolicy.ts";

export const SimulateCustomPolicyHttp = Layer.effect(
  SimulateCustomPolicy,
  makeIamHttpBinding({
    capability: "SimulateCustomPolicy",
    iamActions: ["iam:SimulateCustomPolicy"],
    operation: iam.simulateCustomPolicy,
  }),
);
