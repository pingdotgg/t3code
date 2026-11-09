import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { GetAccountSummary } from "./GetAccountSummary.ts";

export const GetAccountSummaryHttp = Layer.effect(
  GetAccountSummary,
  makeIamHttpBinding({
    capability: "GetAccountSummary",
    iamActions: ["iam:GetAccountSummary"],
    operation: iam.getAccountSummary,
  }),
);
