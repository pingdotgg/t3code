import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";
import { GetTerminology } from "./GetTerminology.ts";

export const GetTerminologyHttp = Layer.effect(
  GetTerminology,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.GetTerminology",
    operation: translate.getTerminology,
    actions: ["translate:GetTerminology"],
  }),
);
