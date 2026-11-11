import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { GenerateDataKey } from "./GenerateDataKey.ts";

export const GenerateDataKeyHttp = Layer.effect(
  GenerateDataKey,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.GenerateDataKey",
    operation: kms.generateDataKey,
    actions: ["kms:GenerateDataKey"],
  }),
);
