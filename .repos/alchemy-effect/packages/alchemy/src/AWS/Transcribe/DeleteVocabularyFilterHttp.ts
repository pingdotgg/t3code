import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DeleteVocabularyFilter } from "./DeleteVocabularyFilter.ts";

export const DeleteVocabularyFilterHttp = Layer.effect(
  DeleteVocabularyFilter,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DeleteVocabularyFilter",
    operation: transcribe.deleteVocabularyFilter,
    actions: ["transcribe:DeleteVocabularyFilter"],
  }),
);
