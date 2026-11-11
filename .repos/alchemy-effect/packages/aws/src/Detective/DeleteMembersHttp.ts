import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { DeleteMembers } from "./DeleteMembers.ts";

export const DeleteMembersHttp = Layer.effect(
  DeleteMembers,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.DeleteMembers",
    operation: detective.deleteMembers,
    actions: ["detective:DeleteMembers"],
  }),
);
