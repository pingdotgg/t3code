import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { BatchGetGraphMemberDatasources } from "./BatchGetGraphMemberDatasources.ts";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";

export const BatchGetGraphMemberDatasourcesHttp = Layer.effect(
  BatchGetGraphMemberDatasources,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.BatchGetGraphMemberDatasources",
    operation: detective.batchGetGraphMemberDatasources,
    actions: ["detective:BatchGetGraphMemberDatasources"],
  }),
);
