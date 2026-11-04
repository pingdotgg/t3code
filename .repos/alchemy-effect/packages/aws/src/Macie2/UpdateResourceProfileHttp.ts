import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateResourceProfile } from "./UpdateResourceProfile.ts";

export const UpdateResourceProfileHttp = Layer.effect(
  UpdateResourceProfile,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateResourceProfile",
    operation: macie2.updateResourceProfile,
    actions: ["macie2:UpdateResourceProfile"],
  }),
);
