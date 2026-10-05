import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { GenerateDownloadUrl } from "./GenerateDownloadUrl.ts";

/**
 * HTTP implementation of {@link GenerateDownloadUrl}.
 *
 * @layer
 * @provides GCP.CloudFunctions.GenerateDownloadUrl
 */
export const GenerateDownloadUrlHttp = Layer.effect(
  GenerateDownloadUrl,
  makeFunctionHttpBinding({
    tag: "GCP.CloudFunctions.GenerateDownloadUrl",
    // Narrowest predefined role with cloudfunctions.functions.sourceCodeGet.
    // 2nd gen functions accept only invoker roles on their own IAM policy,
    // so grant on the project under a condition naming the function.
    iam: { role: "roles/cloudfunctions.developer", scopeByCondition: true },
    operation: cloudfunctions.generateDownloadUrlProjectsLocationsFunctions,
  }),
);
