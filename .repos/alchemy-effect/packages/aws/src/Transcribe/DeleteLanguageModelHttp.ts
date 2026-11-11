import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteLanguageModel } from "./DeleteLanguageModel.ts";

export const DeleteLanguageModelHttp = Layer.effect(
  DeleteLanguageModel,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteLanguageModel",
    operation: transcribe.deleteLanguageModel,
    actions: ["transcribe:DeleteLanguageModel"],
  }),
);
