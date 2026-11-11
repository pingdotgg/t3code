import * as SSM from "@distilled.cloud/aws/ssm";
import * as Layer from "effect/Layer";
import { makeParameterHttpBinding } from "./BindingHttp.ts";
import { GetParameterHistory } from "./GetParameterHistory.ts";

export const GetParameterHistoryHttp = Layer.effect(
  GetParameterHistory,
  makeParameterHttpBinding({
    tag: "AWS.SSM.GetParameterHistory",
    operation: SSM.getParameterHistory,
    actions: ["ssm:GetParameterHistory"],
    // kms:Decrypt so `WithDecryption: true` works on SecureString parameters.
    kmsActions: ["kms:Decrypt"],
  }),
);
