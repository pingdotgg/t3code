import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { BatchGetDocumentStatus } from "./BatchGetDocumentStatus.ts";

export const BatchGetDocumentStatusHttp = Layer.effect(
  BatchGetDocumentStatus,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.BatchGetDocumentStatus",
    operation: kendra.batchGetDocumentStatus,
    actions: ["kendra:BatchGetDocumentStatus"],
  }),
);
