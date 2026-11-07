import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GetServiceLastAccessedDetails } from "./GetServiceLastAccessedDetails.ts";

export const GetServiceLastAccessedDetailsHttp = Layer.effect(
  GetServiceLastAccessedDetails,
  makeIamHttpBinding({
    capability: "GetServiceLastAccessedDetails",
    iamActions: ["iam:GetServiceLastAccessedDetails"],
    operation: iam.getServiceLastAccessedDetails,
  }),
);
