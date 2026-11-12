import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { CreateInvitations } from "./CreateInvitations.ts";

export const CreateInvitationsHttp = Layer.effect(
  CreateInvitations,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.CreateInvitations",
    operation: macie2.createInvitations,
    actions: ["macie2:CreateInvitations"],
  }),
);
