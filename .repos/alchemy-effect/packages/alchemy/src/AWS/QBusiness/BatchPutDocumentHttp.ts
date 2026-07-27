import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";
import { BatchPutDocument } from "./BatchPutDocument.ts";

export const BatchPutDocumentHttp = Layer.effect(
  BatchPutDocument,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.BatchPutDocument",
    operation: qbusiness.batchPutDocument,
    actions: ["qbusiness:BatchPutDocument"],
  }),
);
