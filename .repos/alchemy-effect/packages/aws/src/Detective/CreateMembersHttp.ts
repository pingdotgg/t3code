import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { CreateMembers } from "./CreateMembers.ts";

export const CreateMembersHttp = Layer.effect(
  CreateMembers,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.CreateMembers",
    operation: detective.createMembers,
    actions: ["detective:CreateMembers"],
  }),
);
