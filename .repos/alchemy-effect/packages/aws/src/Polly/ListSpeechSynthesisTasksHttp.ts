import * as polly from "@distilled.cloud/aws/polly";
import * as Layer from "effect/Layer";
import { makePollyHttpBinding } from "./BindingHttp.ts";
import { ListSpeechSynthesisTasks } from "./ListSpeechSynthesisTasks.ts";

export const ListSpeechSynthesisTasksHttp = Layer.effect(
  ListSpeechSynthesisTasks,
  makePollyHttpBinding({
    capability: "ListSpeechSynthesisTasks",
    iamActions: ["polly:ListSpeechSynthesisTasks"],
    operation: polly.listSpeechSynthesisTasks,
  }),
);
