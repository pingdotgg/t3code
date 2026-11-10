import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateMemberSession } from "./UpdateMemberSession.ts";

export const UpdateMemberSessionHttp = Layer.effect(
  UpdateMemberSession,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateMemberSession",
    operation: macie2.updateMemberSession,
    actions: ["macie2:UpdateMemberSession"],
  }),
);
