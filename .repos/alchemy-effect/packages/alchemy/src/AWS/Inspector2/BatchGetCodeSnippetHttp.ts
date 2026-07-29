import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { BatchGetCodeSnippet } from "./BatchGetCodeSnippet.ts";

export const BatchGetCodeSnippetHttp = Layer.effect(
  BatchGetCodeSnippet,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.BatchGetCodeSnippet",
    operation: inspector2.batchGetCodeSnippet,
    actions: ["inspector2:BatchGetCodeSnippet"],
  }),
);
