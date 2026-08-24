import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";
import { BatchDeleteDocument } from "./BatchDeleteDocument.ts";

export const BatchDeleteDocumentHttp = Layer.effect(
  BatchDeleteDocument,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.BatchDeleteDocument",
    operation: qbusiness.batchDeleteDocument,
    actions: ["qbusiness:BatchDeleteDocument"],
  }),
);
