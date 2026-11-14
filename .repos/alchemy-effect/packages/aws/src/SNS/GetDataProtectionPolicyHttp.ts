import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { GetDataProtectionPolicy } from "./GetDataProtectionPolicy.ts";

export const GetDataProtectionPolicyHttp = Layer.effect(
  GetDataProtectionPolicy,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.GetDataProtectionPolicy",
    operation: sns.getDataProtectionPolicy,
    actions: ["sns:GetDataProtectionPolicy"],
    key: "ResourceArn",
  }),
);
