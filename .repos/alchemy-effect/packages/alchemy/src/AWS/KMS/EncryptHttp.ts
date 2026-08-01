import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { Encrypt } from "./Encrypt.ts";

export const EncryptHttp = Layer.effect(
  Encrypt,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.Encrypt",
    operation: kms.encrypt,
    actions: ["kms:Encrypt"],
  }),
);
