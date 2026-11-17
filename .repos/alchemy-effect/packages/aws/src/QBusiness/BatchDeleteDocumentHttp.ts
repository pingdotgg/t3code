import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { BatchDeleteDocument } from "./BatchDeleteDocument.ts";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteDocumentHttp = Layer.effect(
  BatchDeleteDocument,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.BatchDeleteDocument",
    operation: qbusiness.batchDeleteDocument,
    actions: ["qbusiness:BatchDeleteDocument"],
  }),
);
