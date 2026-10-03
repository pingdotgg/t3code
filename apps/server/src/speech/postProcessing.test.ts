import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  type SpeechPostProcessingOptions,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, vi } from "vite-plus/test";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { postProcessTranscript } from "./postProcessing.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-6-luna",
      name: "GPT-6 Luna",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "low", label: "Low" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const runPostProcess = (
  input: {
    readonly transcript: string;
    readonly cwd: string;
    readonly settings?: ServerSettings;
    readonly options?: Partial<SpeechPostProcessingOptions>;
  },
  generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"],
  providers: ReadonlyArray<ServerProvider> = [codexProvider],
) =>
  postProcessTranscript({
    ...input,
    settings: input.settings ?? DEFAULT_SERVER_SETTINGS,
    options: { ...DEFAULT_CLIENT_SETTINGS, ...input.options },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({
          generateTranscriptionPostProcessing: generate,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      ),
    ),
  );

describe("postProcessTranscript", () => {
  it.effect("cleans transcripts through Claude when Codex is not installed", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "Clean text." }),
      );
      const claude: ServerProvider = {
        ...codexProvider,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        models: [
          {
            slug: "claude-haiku-4-5",
            name: "Haiku",
            isCustom: false,
            capabilities: {
              optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
            },
          },
        ],
      };
      expect(
        yield* runPostProcess(
          { transcript: "raw", cwd: "C:/neutral", settings: DEFAULT_SERVER_SETTINGS },
          generate,
          [{ ...codexProvider, installed: false }, claude],
        ),
      ).toBe("Clean text.");
      expect(generate.mock.calls[0]?.[0].modelSelection).toEqual({
        instanceId: "claudeAgent",
        model: "claude-haiku-4-5",
        options: [{ id: "thinking", value: false }],
      });
    }),
  );
  it.effect("uses the dedicated model selection and built-in prompt", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "  Clean text.  " }),
      );
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        speechPostProcessingEnabled: true,
      };

      expect(
        yield* runPostProcess(
          {
            transcript: "uh clean text",
            cwd: "C:/neutral",
            settings,
          },
          generate,
        ),
      ).toBe("Clean text.");
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "C:/neutral",
          modelSelection: settings.speechPostProcessingModelSelection,
          prompt: expect.stringContaining("<transcript>\nuh clean text\n</transcript>"),
        }),
      );
      expect(generate.mock.calls[0]?.[0].prompt).toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
    }),
  );

  it.effect("uses custom instructions when selected", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "Clean text." }),
      );
      yield* runPostProcess(
        {
          transcript: "clean text",
          cwd: "C:/neutral",
          options: {
            ...DEFAULT_CLIENT_SETTINGS,
            speechPostProcessingPrompt: {
              mode: "custom",
              customInstructions: "Keep technical terms verbatim.",
            },
          },
        },
        generate,
      );
      const prompt = generate.mock.calls[0]?.[0].prompt;
      expect(prompt).toContain("Keep technical terms verbatim.");
      expect(prompt).not.toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
    }),
  );

  it.effect("uses built-in cleanup while custom instructions are blank", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "Clean text." }),
      );
      yield* runPostProcess(
        {
          transcript: "clean text",
          cwd: "C:/neutral",
          options: {
            ...DEFAULT_CLIENT_SETTINGS,
            speechPostProcessingPrompt: { mode: "custom", customInstructions: "" },
          },
        },
        generate,
      );
      expect(generate.mock.calls[0]?.[0].prompt).toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
    }),
  );

  it.effect("does not call a provider when disabled", () =>
    Effect.gen(function* () {
      const generate = vi.fn(() => Effect.succeed({ transcription: "unexpected" }));
      expect(
        yield* runPostProcess(
          {
            transcript: "raw text",
            cwd: "C:/neutral",
            options: { ...DEFAULT_CLIENT_SETTINGS, speechPostProcessingEnabled: false },
          },
          generate,
        ),
      ).toBe("raw text");
      expect(generate).not.toHaveBeenCalled();
    }),
  );

  it.effect("adds context-sensitive correction instructions to the prompt", () =>
    Effect.gen(function* () {
      const generate = vi.fn(() => Effect.succeed({ transcription: "I want yellow." }));
      const options = { ...DEFAULT_CLIENT_SETTINGS, speechCorrectionWord: "err" };
      yield* runPostProcess(
        {
          transcript: "I want orange, err, yellow.",
          cwd: "C:/neutral",
          options,
        },
        generate,
      );
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Correction cue: "err"'),
        }),
      );
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            "If the cue is an intended part of the sentence, keep it",
          ),
        }),
      );
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            "<transcript>\nI want orange, err, yellow.\n</transcript>",
          ),
        }),
      );
    }),
  );

  it.effect("preserves the original when the provider returns blank output", () =>
    Effect.gen(function* () {
      expect(
        yield* runPostProcess(
          {
            transcript: "raw text",
            cwd: "C:/neutral",
            options: { ...DEFAULT_CLIENT_SETTINGS, speechPostProcessingEnabled: true },
          },
          () => Effect.succeed({ transcription: "   " }),
        ),
      ).toBe("raw text");
    }),
  );

  it.effect("reapplies dictionary aliases after AI cleanup", () =>
    Effect.gen(function* () {
      expect(
        yield* runPostProcess(
          {
            transcript: "Use MiniMax.",
            cwd: "C:/neutral",
            options: {
              ...DEFAULT_CLIENT_SETTINGS,
              speechCustomWords: [{ term: "MiniMax", aliases: ["mini max"] }],
            },
          },
          () => Effect.succeed({ transcription: "Use mini max." }),
        ),
      ).toBe("Use MiniMax.");
    }),
  );
});
