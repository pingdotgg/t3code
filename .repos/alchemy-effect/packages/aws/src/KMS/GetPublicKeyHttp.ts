import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { GetPublicKey } from "./GetPublicKey.ts";

export const GetPublicKeyHttp = Layer.effect(
  GetPublicKey,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.GetPublicKey",
    operation: kms.getPublicKey,
    actions: ["kms:GetPublicKey"],
  }),
);
