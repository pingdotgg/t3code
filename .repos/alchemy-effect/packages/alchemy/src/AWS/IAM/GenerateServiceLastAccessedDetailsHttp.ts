import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GenerateServiceLastAccessedDetails } from "./GenerateServiceLastAccessedDetails.ts";

export const GenerateServiceLastAccessedDetailsHttp = Layer.effect(
  GenerateServiceLastAccessedDetails,
  makeIamHttpBinding({
    capability: "GenerateServiceLastAccessedDetails",
    iamActions: ["iam:GenerateServiceLastAccessedDetails"],
    operation: iam.generateServiceLastAccessedDetails,
  }),
);
