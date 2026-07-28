import * as translate from "@distilled.cloud/aws/translate";
import * as Layer from "effect/Layer";
import { makeTranslateHttpBinding } from "./BindingHttp.ts";
import { StopTextTranslationJob } from "./StopTextTranslationJob.ts";

export const StopTextTranslationJobHttp = Layer.effect(
  StopTextTranslationJob,
  makeTranslateHttpBinding({
    tag: "AWS.Translate.StopTextTranslationJob",
    operation: translate.stopTextTranslationJob,
    actions: ["translate:StopTextTranslationJob"],
  }),
);
