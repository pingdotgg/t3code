import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { GenerateDataKeyPairWithoutPlaintext } from "./GenerateDataKeyPairWithoutPlaintext.ts";

export const GenerateDataKeyPairWithoutPlaintextHttp = Layer.effect(
  GenerateDataKeyPairWithoutPlaintext,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.GenerateDataKeyPairWithoutPlaintext",
    operation: kms.generateDataKeyPairWithoutPlaintext,
    actions: ["kms:GenerateDataKeyPairWithoutPlaintext"],
  }),
);
