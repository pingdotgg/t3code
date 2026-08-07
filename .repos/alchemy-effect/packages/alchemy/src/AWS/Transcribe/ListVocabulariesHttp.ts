import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListVocabularies } from "./ListVocabularies.ts";

export const ListVocabulariesHttp = Layer.effect(
  ListVocabularies,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListVocabularies",
    operation: transcribe.listVocabularies,
    actions: ["transcribe:ListVocabularies"],
  }),
);
