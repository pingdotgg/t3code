import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ClassifyDocument } from "./ClassifyDocument.ts";

export const ClassifyDocumentHttp = Layer.effect(
  ClassifyDocument,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ClassifyDocument",
    operation: comprehend.classifyDocument,
    actions: ["comprehend:ClassifyDocument"],
  }),
);
