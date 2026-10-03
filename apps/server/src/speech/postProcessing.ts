import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type ServerSettings as ServerSettingsSnapshot,
  type EnvironmentSpeechPostProcessingRequest,
  type SpeechPostProcessingOptions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import { SpeechOperationError } from "./SpeechService.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";

const quoteCorrectionWord = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const postProcessTranscript = Effect.fn("speech.postProcessTranscript")(function* (input: {
  readonly transcript: string;
  readonly draft?: {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  };
  readonly cwd: string;
  readonly settings: ServerSettingsSnapshot;
  readonly options: SpeechPostProcessingOptions;
}) {
  if (!input.options.speechPostProcessingEnabled || input.transcript.trim().length === 0) {
    return input.transcript;
  }
  const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
  const instructions =
    (mode === "custom" ? customInstructions.trim() : "") || DEFAULT_SPEECH_POST_PROCESSING_PROMPT;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const modelSelection = resolveSpeechPostProcessingModelSelection(
    input.settings,
    yield* registry.getProviders,
  );
  const { prompt } = buildTranscriptionPostProcessingPrompt(
    input.options.speechCorrectionWord.trim()
      ? `${instructions}\n\nCorrection cue: ${quoteCorrectionWord(input.options.speechCorrectionWord.trim())}. Only when this cue clearly marks a spoken self-correction, apply the correction the speaker made and omit the cue from the result. The correction may revise, add to, or retract earlier speech. Preserve everything else. If the cue is an intended part of the sentence, keep it. Use the surrounding context to decide; do not assume every occurrence is a correction.`
      : instructions,
    input.transcript,
    input.draft,
  );
  const generated = yield* textGeneration.generateTranscriptionPostProcessing({
    cwd: input.cwd,
    prompt,
    modelSelection,
  });
  const text = generated.transcription.trim();
  return text.length > 0
    ? applySpeechAliases(text, input.options.speechCustomWords)
    : input.transcript;
});

export class SpeechPostProcessing extends Context.Service<
  SpeechPostProcessing,
  {
    readonly process: (
      input: EnvironmentSpeechPostProcessingRequest,
    ) => Effect.Effect<{ text: string }, SpeechOperationError>;
  }
>()("t3/speech/postProcessing/SpeechPostProcessing") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  return SpeechPostProcessing.of({
    process: Effect.fn("speech.postProcess")(
      function* (input) {
        const settings = yield* settingsService.getSettings;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-voice-post-processing-",
        });
        const text = yield* postProcessTranscript({ ...input, settings, cwd }).pipe(
          Effect.provideService(TextGeneration.TextGeneration, textGeneration),
          Effect.provideService(ProviderRegistry.ProviderRegistry, registry),
        );
        return { text };
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "post-processing", cause })),
    ),
  });
});

export const layer = Layer.effect(SpeechPostProcessing, make);
