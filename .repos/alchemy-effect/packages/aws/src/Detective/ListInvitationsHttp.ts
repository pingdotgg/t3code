import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";
import { ListInvitations } from "./ListInvitations.ts";

export const ListInvitationsHttp = Layer.effect(
  ListInvitations,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.ListInvitations",
    operation: detective.listInvitations,
    actions: ["detective:ListInvitations"],
  }),
);
