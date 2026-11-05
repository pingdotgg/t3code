import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsKeyHttpBinding } from "./BindingHttp.ts";
import { Sign } from "./Sign.ts";

export const SignHttp = Layer.effect(
  Sign,
  makeKmsKeyHttpBinding({
    tag: "AWS.KMS.Sign",
    operation: kms.sign,
    actions: ["kms:Sign"],
  }),
);
