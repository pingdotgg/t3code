import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { BatchGetDocumentStatus } from "./BatchGetDocumentStatus.ts";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";

export const BatchGetDocumentStatusHttp = Layer.effect(
  BatchGetDocumentStatus,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.BatchGetDocumentStatus",
    operation: kendra.batchGetDocumentStatus,
    actions: ["kendra:BatchGetDocumentStatus"],
  }),
);
