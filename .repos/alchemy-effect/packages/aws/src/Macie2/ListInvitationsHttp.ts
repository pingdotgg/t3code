import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { ListInvitations } from "./ListInvitations.ts";

export const ListInvitationsHttp = Layer.effect(
  ListInvitations,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListInvitations",
    operation: macie2.listInvitations,
    actions: ["macie2:ListInvitations"],
  }),
);
