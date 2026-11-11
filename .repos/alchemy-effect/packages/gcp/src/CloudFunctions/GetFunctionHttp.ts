import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { GetFunction } from "./GetFunction.ts";

/**
 * HTTP implementation of {@link GetFunction}.
 *
 * @layer
 * @provides GCP.CloudFunctions.GetFunction
 */
export const GetFunctionHttp = Layer.effect(
  GetFunction,
  makeFunctionHttpBinding({
    tag: "GCP.CloudFunctions.GetFunction",
    // 2nd gen functions accept only invoker roles on their own IAM policy
    // (anything else is INVALID_ARGUMENT), so grant on the project under a
    // condition naming the function.
    iam: { role: "roles/cloudfunctions.viewer", scopeByCondition: true },
    operation: cloudfunctions.getProjectsLocationsFunctions,
  }),
);
