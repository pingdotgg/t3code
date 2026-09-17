import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { postProcessTranscript } from "./postProcessing.ts";

const textGeneration = (
  generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"],
) =>
  ({
    generateTranscriptionPostProcessing: generate,
  }) as unknown as TextGeneration.TextGeneration["Service"];

describe("postProcessTranscript", () => {
  it("uses the dedicated model selection and selected prompt", async () => {
    const generate = vi.fn(() => Effect.succeed({ transcription: "  Clean text.  " }));
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      speechPostProcessingEnabled: true,
    };

    await expect(
      Effect.runPromise(
        postProcessTranscript({
          transcript: "uh clean text",
          cwd: "C:/neutral",
          settings,
          textGeneration: textGeneration(generate),
        }),
      ),
    ).resolves.toBe("Clean text.");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "C:/neutral",
        modelSelection: settings.speechPostProcessingModelSelection,
        prompt: expect.stringContaining("<transcript>\nuh clean text\n</transcript>"),
      }),
    );
  });

  it("does not call a provider when disabled", async () => {
    const generate = vi.fn(() => Effect.succeed({ transcription: "unexpected" }));
    await expect(
      Effect.runPromise(
        postProcessTranscript({
          transcript: "raw text",
          cwd: "C:/neutral",
          settings: DEFAULT_SERVER_SETTINGS,
          textGeneration: textGeneration(generate),
        }),
      ),
    ).resolves.toBe("raw text");
    expect(generate).not.toHaveBeenCalled();
  });

  it("preserves the original when the provider returns blank output", async () => {
    await expect(
      Effect.runPromise(
        postProcessTranscript({
          transcript: "raw text",
          cwd: "C:/neutral",
          settings: { ...DEFAULT_SERVER_SETTINGS, speechPostProcessingEnabled: true },
          textGeneration: textGeneration(() => Effect.succeed({ transcription: "   " })),
        }),
      ),
    ).resolves.toBe("raw text");
  });
});
