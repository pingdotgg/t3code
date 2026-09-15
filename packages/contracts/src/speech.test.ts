import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvironmentSpeechStatus, EnvironmentSpeechTranscriptionResult } from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(EnvironmentSpeechStatus);
const decodeTranscription = Schema.decodeUnknownSync(EnvironmentSpeechTranscriptionResult);

describe("environment speech contracts", () => {
  it("accepts supported and unsupported statuses", () => {
    expect(
      decodeStatus({
        supported: true,
        state: "ready",
        modelId: "handy-computer/moonshine-tiny-gguf",
        model: "Moonshine Tiny",
        size: 35_466_912,
        supportsStreaming: false,
        customWords: ["T3 Code"],
        removeFillerWords: false,
      }),
    ).toEqual({
      supported: true,
      state: "ready",
      modelId: "handy-computer/moonshine-tiny-gguf",
      model: "Moonshine Tiny",
      size: 35_466_912,
      supportsStreaming: false,
      customWords: ["T3 Code"],
      removeFillerWords: false,
    });
    expect(decodeStatus({ supported: false, reason: "unsupported platform" })).toEqual({
      supported: false,
      reason: "unsupported platform",
    });
  });

  it("defaults custom words and bounds vocabulary entries", () => {
    expect(
      decodeStatus({
        supported: true,
        state: "ready",
        modelId: "model",
        model: "Model",
        size: 1,
        supportsStreaming: false,
      }),
    ).toMatchObject({ customWords: [], removeFillerWords: true });
    expect(() =>
      decodeStatus({
        supported: true,
        state: "ready",
        modelId: "model",
        model: "Model",
        size: 1,
        supportsStreaming: false,
        customWords: ["x".repeat(51)],
      }),
    ).toThrow();
  });

  it("accepts a transcription result", () => {
    expect(decodeTranscription({ text: "hello" })).toEqual({ text: "hello" });
  });
});
