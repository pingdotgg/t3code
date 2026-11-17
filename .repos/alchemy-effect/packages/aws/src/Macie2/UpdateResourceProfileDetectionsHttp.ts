import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateResourceProfileDetections } from "./UpdateResourceProfileDetections.ts";

export const UpdateResourceProfileDetectionsHttp = Layer.effect(
  UpdateResourceProfileDetections,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateResourceProfileDetections",
    operation: macie2.updateResourceProfileDetections,
    actions: ["macie2:UpdateResourceProfileDetections"],
  }),
);
