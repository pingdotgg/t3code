import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DetectSyntax } from "./DetectSyntax.ts";

export const DetectSyntaxHttp = Layer.effect(
  DetectSyntax,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DetectSyntax",
    operation: comprehend.detectSyntax,
    actions: ["comprehend:DetectSyntax"],
  }),
);
