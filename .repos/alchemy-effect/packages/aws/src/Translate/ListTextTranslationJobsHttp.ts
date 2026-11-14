import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";
import { ListTextTranslationJobs } from "./ListTextTranslationJobs.ts";

export const ListTextTranslationJobsHttp = Layer.effect(
  ListTextTranslationJobs,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.ListTextTranslationJobs",
    operation: translate.listTextTranslationJobs,
    actions: ["translate:ListTextTranslationJobs"],
  }),
);
