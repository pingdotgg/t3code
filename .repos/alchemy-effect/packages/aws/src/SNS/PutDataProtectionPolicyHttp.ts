import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { PutDataProtectionPolicy } from "./PutDataProtectionPolicy.ts";

export const PutDataProtectionPolicyHttp = Layer.effect(
  PutDataProtectionPolicy,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.PutDataProtectionPolicy",
    operation: sns.putDataProtectionPolicy,
    actions: ["sns:PutDataProtectionPolicy"],
    key: "ResourceArn",
  }),
);
