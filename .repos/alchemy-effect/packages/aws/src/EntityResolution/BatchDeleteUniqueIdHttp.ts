import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Layer from "effect/Layer";
import { BatchDeleteUniqueId } from "./BatchDeleteUniqueId.ts";
import { makeWorkflowHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteUniqueIdHttp = Layer.effect(
  BatchDeleteUniqueId,
  makeWorkflowHttpBinding({
    tag: "AWS.EntityResolution.BatchDeleteUniqueId",
    operation: entityresolution.batchDeleteUniqueId,
    actions: ["entityresolution:BatchDeleteUniqueId"],
  }),
);
