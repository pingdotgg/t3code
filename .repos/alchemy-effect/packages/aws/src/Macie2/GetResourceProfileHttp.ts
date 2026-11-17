import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetResourceProfile } from "./GetResourceProfile.ts";

export const GetResourceProfileHttp = Layer.effect(
  GetResourceProfile,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetResourceProfile",
    operation: macie2.getResourceProfile,
    actions: ["macie2:GetResourceProfile"],
  }),
);
