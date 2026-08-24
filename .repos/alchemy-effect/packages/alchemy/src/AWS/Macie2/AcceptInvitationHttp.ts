import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { AcceptInvitation } from "./AcceptInvitation.ts";

export const AcceptInvitationHttp = Layer.effect(
  AcceptInvitation,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.AcceptInvitation",
    operation: macie2.acceptInvitation,
    actions: ["macie2:AcceptInvitation"],
  }),
);
