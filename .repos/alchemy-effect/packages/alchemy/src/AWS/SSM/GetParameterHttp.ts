import * as SSM from "@distilled.cloud/aws/ssm";
import * as Layer from "effect/Layer";
import { makeParameterHttpBinding } from "./BindingHttp.ts";
import { GetParameter } from "./GetParameter.ts";

export const GetParameterHttp = Layer.effect(
  GetParameter,
  makeParameterHttpBinding({
    tag: "AWS.SSM.GetParameter",
    operation: SSM.getParameter,
    actions: ["ssm:GetParameter"],
    // kms:Decrypt so `WithDecryption: true` works on SecureString parameters.
    kmsActions: ["kms:Decrypt"],
  }),
);
