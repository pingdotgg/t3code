import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { UpdateVocabularyFilter } from "./UpdateVocabularyFilter.ts";

export const UpdateVocabularyFilterHttp = Layer.effect(
  UpdateVocabularyFilter,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.UpdateVocabularyFilter",
    operation: transcribe.updateVocabularyFilter,
    actions: ["transcribe:UpdateVocabularyFilter"],
  }),
);
