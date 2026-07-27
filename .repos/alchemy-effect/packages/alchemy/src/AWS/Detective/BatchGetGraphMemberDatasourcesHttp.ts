import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { BatchGetGraphMemberDatasources } from "./BatchGetGraphMemberDatasources.ts";

export const BatchGetGraphMemberDatasourcesHttp = Layer.effect(
  BatchGetGraphMemberDatasources,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.BatchGetGraphMemberDatasources",
    operation: detective.batchGetGraphMemberDatasources,
    actions: ["detective:BatchGetGraphMemberDatasources"],
  }),
);
