import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentSpeechPostProcessingRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";
import { SpeechOperationError } from "./SpeechService.ts";

export class SpeechPostProcessing extends Context.Service<
  SpeechPostProcessing,
  {
    readonly process: (
      input: EnvironmentSpeechPostProcessingRequest,
    ) => Effect.Effect<{ readonly text: string }, SpeechOperationError>;
  }
>()("t3/speech/postProcessing/SpeechPostProcessing") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  return SpeechPostProcessing.of({
    process: Effect.fn("SpeechPostProcessing.process")(
      function* (input) {
        if (input.transcript.trim().length === 0) return { text: input.transcript };
        const settings = yield* settingsService.getSettings;
        const providers = yield* providerRegistry.getProviders;
        const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
        const instructions =
          (mode === "custom" ? customInstructions.trim() : "") ||
          DEFAULT_SPEECH_POST_PROCESSING_PROMPT;
        // Providers run in a working directory; cleanup must not read a checkout.
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-cleanup-" });
        const generated = yield* textGeneration.generateTranscriptionPostProcessing({
          cwd,
          prompt: buildTranscriptionPostProcessingPrompt(
            instructions,
            input.transcript,
            input.draft,
            input.options.speechCorrectionWord,
          ),
          modelSelection: resolveSpeechPostProcessingModelSelection(settings, providers),
        });
        const text = generated.transcription.trim();
        return {
          text:
            text.length > 0
              ? applySpeechAliases(text, input.options.speechCustomWords)
              : input.transcript,
        };
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "post-processing", cause })),
    ),
  });
});

export const layer = Layer.effect(SpeechPostProcessing, make);
