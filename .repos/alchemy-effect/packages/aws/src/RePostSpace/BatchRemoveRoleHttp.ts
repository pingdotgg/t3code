import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { BatchRemoveRole } from "./BatchRemoveRole.ts";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";

export const BatchRemoveRoleHttp = Layer.effect(
  BatchRemoveRole,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.BatchRemoveRole",
    operation: repostspace.batchRemoveRole,
    actions: ["repostspace:BatchRemoveRole"],
  }),
);
