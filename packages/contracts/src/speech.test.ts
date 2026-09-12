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
      }),
    ).toEqual({
      supported: true,
      state: "ready",
      modelId: "handy-computer/moonshine-tiny-gguf",
      model: "Moonshine Tiny",
      size: 35_466_912,
      supportsStreaming: false,
    });
    expect(decodeStatus({ supported: false, reason: "unsupported platform" })).toEqual({
      supported: false,
      reason: "unsupported platform",
    });
  });

  it("accepts a transcription result", () => {
    expect(decodeTranscription({ text: "hello" })).toEqual({ text: "hello" });
  });
});
