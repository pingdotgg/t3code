import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { DeclineInvitations } from "./DeclineInvitations.ts";

export const DeclineInvitationsHttp = Layer.effect(
  DeclineInvitations,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.DeclineInvitations",
    operation: macie2.declineInvitations,
    actions: ["macie2:DeclineInvitations"],
  }),
);
