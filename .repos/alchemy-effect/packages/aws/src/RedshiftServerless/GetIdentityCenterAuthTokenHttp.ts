import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { GetIdentityCenterAuthToken } from "./GetIdentityCenterAuthToken.ts";

export const GetIdentityCenterAuthTokenHttp = Layer.effect(
  GetIdentityCenterAuthToken,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.GetIdentityCenterAuthToken",
    operation: serverless.getIdentityCenterAuthToken,
    actions: ["redshift-serverless:GetIdentityCenterAuthToken"],
  }),
);
