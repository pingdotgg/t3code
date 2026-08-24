import * as polly from "@distilled.cloud/aws/polly";
import * as Layer from "effect/Layer";
import { makePollyHttpBinding } from "./BindingHttp.ts";
import { GetSpeechSynthesisTask } from "./GetSpeechSynthesisTask.ts";

export const GetSpeechSynthesisTaskHttp = Layer.effect(
  GetSpeechSynthesisTask,
  makePollyHttpBinding({
    capability: "GetSpeechSynthesisTask",
    iamActions: ["polly:GetSpeechSynthesisTask"],
    operation: polly.getSpeechSynthesisTask,
  }),
);
