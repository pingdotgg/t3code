import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { CreateMember } from "./CreateMember.ts";

export const CreateMemberHttp = Layer.effect(
  CreateMember,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.CreateMember",
    operation: macie2.createMember,
    actions: ["macie2:CreateMember"],
  }),
);
