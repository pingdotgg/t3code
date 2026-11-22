import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { GetVocabularyFilter } from "./GetVocabularyFilter.ts";

export const GetVocabularyFilterHttp = Layer.effect(
  GetVocabularyFilter,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.GetVocabularyFilter",
    operation: transcribe.getVocabularyFilter,
    actions: ["transcribe:GetVocabularyFilter"],
  }),
);
