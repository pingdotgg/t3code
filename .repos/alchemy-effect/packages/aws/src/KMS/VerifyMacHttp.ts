import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { VerifyMac } from "./VerifyMac.ts";

export const VerifyMacHttp = Layer.effect(
  VerifyMac,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.VerifyMac",
    operation: kms.verifyMac,
    actions: ["kms:VerifyMac"],
  }),
);
