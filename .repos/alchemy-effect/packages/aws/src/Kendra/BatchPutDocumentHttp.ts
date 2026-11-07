import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { BatchPutDocument } from "./BatchPutDocument.ts";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";

export const BatchPutDocumentHttp = Layer.effect(
  BatchPutDocument,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.BatchPutDocument",
    operation: kendra.batchPutDocument,
    actions: ["kendra:BatchPutDocument"],
  }),
);
