import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { BatchRemoveChannelRoleFromAccessors } from "./BatchRemoveChannelRoleFromAccessors.ts";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";

export const BatchRemoveChannelRoleFromAccessorsHttp = Layer.effect(
  BatchRemoveChannelRoleFromAccessors,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.BatchRemoveChannelRoleFromAccessors",
    operation: repostspace.batchRemoveChannelRoleFromAccessors,
    actions: ["repostspace:BatchRemoveChannelRoleFromAccessors"],
  }),
);
