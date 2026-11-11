import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListMembers } from "./ListMembers.ts";

export const ListMembersHttp = Layer.effect(
  ListMembers,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListMembers",
    operation: inspector2.listMembers,
    actions: ["inspector2:ListMembers"],
  }),
);
