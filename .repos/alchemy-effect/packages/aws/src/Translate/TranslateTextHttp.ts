import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";
import { TranslateText } from "./TranslateText.ts";

export const TranslateTextHttp = Layer.effect(
  TranslateText,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.TranslateText",
    operation: translate.translateText,
    actions: ["translate:TranslateText"],
  }),
);
