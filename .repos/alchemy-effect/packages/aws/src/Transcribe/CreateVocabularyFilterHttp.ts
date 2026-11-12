import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { CreateVocabularyFilter } from "./CreateVocabularyFilter.ts";

export const CreateVocabularyFilterHttp = Layer.effect(
  CreateVocabularyFilter,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.CreateVocabularyFilter",
    operation: transcribe.createVocabularyFilter,
    actions: ["transcribe:CreateVocabularyFilter"],
  }),
);
