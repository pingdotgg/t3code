import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { DeriveSharedSecret } from "./DeriveSharedSecret.ts";

export const DeriveSharedSecretHttp = Layer.effect(
  DeriveSharedSecret,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.DeriveSharedSecret",
    operation: kms.deriveSharedSecret,
    actions: ["kms:DeriveSharedSecret"],
  }),
);
