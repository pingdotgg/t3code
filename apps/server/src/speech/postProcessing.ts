import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";

export const postProcessTranscript = Effect.fn("speech.postProcessTranscript")(function* (input: {
  readonly transcript: string;
  readonly cwd: string;
  readonly settings: ServerSettings;
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
}) {
  if (!input.settings.speechPostProcessingEnabled || input.transcript.trim().length === 0) {
    return input.transcript;
  }
  const selectedPrompt = input.settings.speechPostProcessingPrompts.find(
    (prompt) => prompt.id === input.settings.speechPostProcessingSelectedPromptId,
  );
  if (!selectedPrompt) return input.transcript;
  const { prompt } = buildTranscriptionPostProcessingPrompt(
    selectedPrompt.prompt,
    input.transcript,
  );
  const generated = yield* input.textGeneration.generateTranscriptionPostProcessing({
    cwd: input.cwd,
    prompt,
    modelSelection: input.settings.speechPostProcessingModelSelection,
  });
  const text = generated.transcription.trim();
  return text.length > 0 ? text : input.transcript;
});
