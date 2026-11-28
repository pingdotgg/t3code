import * as SSM from "@distilled.cloud/aws/ssm";
import * as Layer from "effect/Layer";
import { makeParameterHttpBinding } from "./BindingHttp.ts";
import { LabelParameterVersion } from "./LabelParameterVersion.ts";

export const LabelParameterVersionHttp = Layer.effect(
  LabelParameterVersion,
  makeParameterHttpBinding({
    tag: "AWS.SSM.LabelParameterVersion",
    operation: SSM.labelParameterVersion,
    actions: ["ssm:LabelParameterVersion"],
  }),
);
