import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { BatchDeleteDocument } from "./BatchDeleteDocument.ts";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteDocumentHttp = Layer.effect(
  BatchDeleteDocument,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.BatchDeleteDocument",
    operation: kendra.batchDeleteDocument,
    actions: ["kendra:BatchDeleteDocument"],
  }),
);
