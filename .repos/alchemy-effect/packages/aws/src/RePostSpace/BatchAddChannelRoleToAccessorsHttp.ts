import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { BatchAddChannelRoleToAccessors } from "./BatchAddChannelRoleToAccessors.ts";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";

export const BatchAddChannelRoleToAccessorsHttp = Layer.effect(
  BatchAddChannelRoleToAccessors,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.BatchAddChannelRoleToAccessors",
    operation: repostspace.batchAddChannelRoleToAccessors,
    actions: ["repostspace:BatchAddChannelRoleToAccessors"],
  }),
);
