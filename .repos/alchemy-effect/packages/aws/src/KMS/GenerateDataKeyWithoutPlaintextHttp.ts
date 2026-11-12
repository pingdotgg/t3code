import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { GenerateDataKeyWithoutPlaintext } from "./GenerateDataKeyWithoutPlaintext.ts";

export const GenerateDataKeyWithoutPlaintextHttp = Layer.effect(
  GenerateDataKeyWithoutPlaintext,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.GenerateDataKeyWithoutPlaintext",
    operation: kms.generateDataKeyWithoutPlaintext,
    actions: ["kms:GenerateDataKeyWithoutPlaintext"],
  }),
);
