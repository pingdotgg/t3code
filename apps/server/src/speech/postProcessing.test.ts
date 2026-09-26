import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, vi } from "vite-plus/test";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { postProcessTranscript } from "./postProcessing.ts";

const runPostProcess = (
  input: { readonly transcript: string; readonly cwd: string; readonly settings: ServerSettings },
  generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"],
) =>
  postProcessTranscript(input).pipe(
    Effect.provide(
      Layer.mock(TextGeneration.TextGeneration)({ generateTranscriptionPostProcessing: generate }),
    ),
  );

describe("postProcessTranscript", () => {
  it.effect("uses the dedicated model selection and selected prompt", () =>
    Effect.gen(function* () {
      const generate = vi.fn(() => Effect.succeed({ transcription: "  Clean text.  " }));
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
            settings: { ...DEFAULT_SERVER_SETTINGS, speechPostProcessingEnabled: false },
          },
          generate,
        ),
      ).toBe("raw text");
      expect(generate).not.toHaveBeenCalled();
    }),
  );

  it.effect("adds context-sensitive correction instructions to the selected prompt", () =>
    Effect.gen(function* () {
      const generate = vi.fn(() => Effect.succeed({ transcription: "I want yellow." }));
      const settings = { ...DEFAULT_SERVER_SETTINGS, speechCorrectionWord: "err" };
      yield* runPostProcess(
        {
          transcript: "I want orange, err, yellow.",
          cwd: "C:/neutral",
          settings,
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
            settings: { ...DEFAULT_SERVER_SETTINGS, speechPostProcessingEnabled: true },
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
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              speechCustomWords: [{ term: "MiniMax", aliases: ["mini max"] }],
            },
          },
          () => Effect.succeed({ transcription: "Use mini max." }),
        ),
      ).toBe("Use MiniMax.");
    }),
  );
});
