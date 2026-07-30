import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListLanguageModels } from "./ListLanguageModels.ts";

export const ListLanguageModelsHttp = Layer.effect(
  ListLanguageModels,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListLanguageModels",
    operation: transcribe.listLanguageModels,
    actions: ["transcribe:ListLanguageModels"],
  }),
);
