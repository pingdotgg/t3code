import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { Verify } from "./Verify.ts";

export const VerifyHttp = Layer.effect(
  Verify,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.Verify",
    operation: kms.verify,
    actions: ["kms:Verify"],
  }),
);
