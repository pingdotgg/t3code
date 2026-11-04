import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { BatchAddRole } from "./BatchAddRole.ts";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";

export const BatchAddRoleHttp = Layer.effect(
  BatchAddRole,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.BatchAddRole",
    operation: repostspace.batchAddRole,
    actions: ["repostspace:BatchAddRole"],
  }),
);
