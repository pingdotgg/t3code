import * as kms from "@distilled.cloud/aws/kms";
import * as Layer from "effect/Layer";
import { makeKmsAccountHttpBinding } from "./BindingHttp.ts";
import { GenerateRandom } from "./GenerateRandom.ts";

export const GenerateRandomHttp = Layer.effect(
  GenerateRandom,
  makeKmsAccountHttpBinding({
    tag: "AWS.KMS.GenerateRandom",
    operation: kms.generateRandom,
    actions: ["kms:GenerateRandom"],
  }),
);
