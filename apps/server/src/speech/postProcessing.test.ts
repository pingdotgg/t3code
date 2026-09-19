import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { postProcessTranscript } from "./postProcessing.ts";

const textGeneration = (
  generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"],
) =>
  ({
    generateTranscriptionPostProcessing: generate,
  }) as unknown as TextGeneration.TextGeneration["Service"];

describe("postProcessTranscript", () => {
  it.effect("uses the dedicated model selection and selected prompt", () =>
    Effect.gen(function* () {
      const generate = vi.fn(() => Effect.succeed({ transcription: "  Clean text.  " }));
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        speechPostProcessingEnabled: true,
      };

      expect(
        yield* postProcessTranscript({
          transcript: "uh clean text",
          cwd: "C:/neutral",
          settings,
          textGeneration: textGeneration(generate),
        }),
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
        yield* postProcessTranscript({
          transcript: "raw text",
          cwd: "C:/neutral",
          settings: DEFAULT_SERVER_SETTINGS,
          textGeneration: textGeneration(generate),
        }),
      ).toBe("raw text");
      expect(generate).not.toHaveBeenCalled();
    }),
  );

  it.effect("preserves the original when the provider returns blank output", () =>
    Effect.gen(function* () {
      expect(
        yield* postProcessTranscript({
          transcript: "raw text",
          cwd: "C:/neutral",
          settings: { ...DEFAULT_SERVER_SETTINGS, speechPostProcessingEnabled: true },
          textGeneration: textGeneration(() => Effect.succeed({ transcription: "   " })),
        }),
      ).toBe("raw text");
    }),
  );
});
