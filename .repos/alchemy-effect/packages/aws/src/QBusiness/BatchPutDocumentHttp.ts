import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { BatchPutDocument } from "./BatchPutDocument.ts";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";

export const BatchPutDocumentHttp = Layer.effect(
  BatchPutDocument,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.BatchPutDocument",
    operation: qbusiness.batchPutDocument,
    actions: ["qbusiness:BatchPutDocument"],
  }),
);
