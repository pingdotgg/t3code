import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GenerateCredentialReport } from "./GenerateCredentialReport.ts";

export const GenerateCredentialReportHttp = Layer.effect(
  GenerateCredentialReport,
  makeIamHttpBinding({
    capability: "GenerateCredentialReport",
    iamActions: ["iam:GenerateCredentialReport"],
    operation: iam.generateCredentialReport,
  }),
);
