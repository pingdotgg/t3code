import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { ListMembers } from "./ListMembers.ts";

export const ListMembersHttp = Layer.effect(
  ListMembers,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.ListMembers",
    operation: detective.listMembers,
    actions: ["detective:ListMembers"],
  }),
);
