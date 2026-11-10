import * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import * as Layer from "effect/Layer";
import { makeModelScopedHttpBinding } from "./BindingHttp.ts";
import { Converse } from "./Converse.ts";

export const ConverseHttp = Layer.effect(
  Converse,
  makeModelScopedHttpBinding({
    tag: "AWS.Bedrock.Converse",
    operation: bedrock.converse,
    actions: ["bedrock:InvokeModel"],
  }),
);
