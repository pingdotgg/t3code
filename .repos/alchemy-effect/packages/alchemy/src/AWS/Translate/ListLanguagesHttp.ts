import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";
import { ListLanguages } from "./ListLanguages.ts";

export const ListLanguagesHttp = Layer.effect(
  ListLanguages,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.ListLanguages",
    operation: translate.listLanguages,
    actions: ["translate:ListLanguages"],
  }),
);
