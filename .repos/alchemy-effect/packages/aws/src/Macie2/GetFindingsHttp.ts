import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetFindings } from "./GetFindings.ts";

export const GetFindingsHttp = Layer.effect(
  GetFindings,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetFindings",
    operation: macie2.getFindings,
    actions: ["macie2:GetFindings"],
  }),
);
