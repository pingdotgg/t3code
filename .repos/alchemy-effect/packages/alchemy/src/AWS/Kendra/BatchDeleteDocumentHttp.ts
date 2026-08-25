import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { BatchDeleteDocument } from "./BatchDeleteDocument.ts";

export const BatchDeleteDocumentHttp = Layer.effect(
  BatchDeleteDocument,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.BatchDeleteDocument",
    operation: kendra.batchDeleteDocument,
    actions: ["kendra:BatchDeleteDocument"],
  }),
);
