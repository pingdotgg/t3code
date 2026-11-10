import * as SSM from "@distilled.cloud/aws/ssm";
import * as Layer from "effect/Layer";
import { makeParameterHttpBinding } from "./BindingHttp.ts";
import { PutParameter } from "./PutParameter.ts";

export const PutParameterHttp = Layer.effect(
  PutParameter,
  makeParameterHttpBinding({
    tag: "AWS.SSM.PutParameter",
    operation: SSM.putParameter,
    actions: ["ssm:PutParameter"],
    // kms:Encrypt + kms:GenerateDataKey so SecureString writes work with the
    // parameter's customer-managed key (GenerateDataKey covers Advanced-tier
    // parameters, which envelope-encrypt).
    kmsActions: ["kms:Encrypt", "kms:GenerateDataKey"],
  }),
);
