import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { Decrypt } from "./Decrypt.ts";

export const DecryptHttp = Layer.effect(
  Decrypt,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.Decrypt",
    operation: kms.decrypt,
    actions: ["kms:Decrypt"],
  }),
);
