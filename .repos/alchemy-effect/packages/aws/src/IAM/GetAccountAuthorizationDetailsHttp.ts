import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GetAccountAuthorizationDetails } from "./GetAccountAuthorizationDetails.ts";

export const GetAccountAuthorizationDetailsHttp = Layer.effect(
  GetAccountAuthorizationDetails,
  makeIamHttpBinding({
    capability: "GetAccountAuthorizationDetails",
    iamActions: ["iam:GetAccountAuthorizationDetails"],
    operation: iam.getAccountAuthorizationDetails,
  }),
);
