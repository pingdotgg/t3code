import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateClassificationScope } from "./UpdateClassificationScope.ts";

export const UpdateClassificationScopeHttp = Layer.effect(
  UpdateClassificationScope,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateClassificationScope",
    operation: macie2.updateClassificationScope,
    actions: ["macie2:UpdateClassificationScope"],
  }),
);
