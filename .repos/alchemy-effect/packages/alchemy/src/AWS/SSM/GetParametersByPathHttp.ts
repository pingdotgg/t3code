import * as SSM from "@distilled.cloud/aws/ssm";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeParameterHttpBinding } from "./BindingHttp.ts";
import { GetParametersByPath } from "./GetParametersByPath.ts";

export const GetParametersByPathHttp = Layer.effect(
  GetParametersByPath,
  makeParameterHttpBinding({
    tag: "AWS.SSM.GetParametersByPath",
    operation: SSM.getParametersByPath,
    actions: ["ssm:GetParametersByPath"],
    requestKey: "Path",
    // The by-path read authorizes against the subtree under the bound
    // parameter's name, so grant on the parameter ARN plus its `/*` children.
    resources: (parameter) => [
      parameter.parameterArn,
      Output.interpolate`${parameter.parameterArn}/*`,
    ],
    // kms:Decrypt so `WithDecryption: true` works for SecureString children
    // encrypted with the bound parameter's key.
    kmsActions: ["kms:Decrypt"],
  }),
);
