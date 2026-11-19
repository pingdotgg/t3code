import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { GenerateDataKeyPair } from "./GenerateDataKeyPair.ts";

export const GenerateDataKeyPairHttp = Layer.effect(
  GenerateDataKeyPair,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.GenerateDataKeyPair",
    operation: kms.generateDataKeyPair,
    actions: ["kms:GenerateDataKeyPair"],
  }),
);
