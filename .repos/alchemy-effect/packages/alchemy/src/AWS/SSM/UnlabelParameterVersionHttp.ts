import * as SSM from "@distilled.cloud/aws/ssm";
import * as Layer from "effect/Layer";
import { makeParameterHttpBinding } from "./BindingHttp.ts";
import { UnlabelParameterVersion } from "./UnlabelParameterVersion.ts";

export const UnlabelParameterVersionHttp = Layer.effect(
  UnlabelParameterVersion,
  makeParameterHttpBinding({
    tag: "AWS.SSM.UnlabelParameterVersion",
    operation: SSM.unlabelParameterVersion,
    actions: ["ssm:UnlabelParameterVersion"],
  }),
);
