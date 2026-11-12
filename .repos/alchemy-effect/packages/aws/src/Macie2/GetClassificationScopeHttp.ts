import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetClassificationScope } from "./GetClassificationScope.ts";

export const GetClassificationScopeHttp = Layer.effect(
  GetClassificationScope,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetClassificationScope",
    operation: macie2.getClassificationScope,
    actions: ["macie2:GetClassificationScope"],
  }),
);
