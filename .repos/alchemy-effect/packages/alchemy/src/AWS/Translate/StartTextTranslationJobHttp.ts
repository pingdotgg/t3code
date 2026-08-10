import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateStartJobHttpBinding } from "./BindingHttp.ts";
import { StartTextTranslationJob } from "./StartTextTranslationJob.ts";

export const StartTextTranslationJobHttp = Layer.effect(
  StartTextTranslationJob,
  makeTranslateStartJobHttpBinding({
    tag: "AWS.Translate.StartTextTranslationJob",
    operation: translate.startTextTranslationJob,
    actions: ["translate:StartTextTranslationJob"],
  }),
);
