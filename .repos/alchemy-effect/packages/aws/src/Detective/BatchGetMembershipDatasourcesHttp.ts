import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { BatchGetMembershipDatasources } from "./BatchGetMembershipDatasources.ts";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";

export const BatchGetMembershipDatasourcesHttp = Layer.effect(
  BatchGetMembershipDatasources,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.BatchGetMembershipDatasources",
    operation: detective.batchGetMembershipDatasources,
    actions: ["detective:BatchGetMembershipDatasources"],
  }),
);
