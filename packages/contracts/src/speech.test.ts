import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  EnvironmentSpeechStatus,
  EnvironmentSpeechTranscriptionResult,
  SpeechTranscriptionOptions,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
} from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(EnvironmentSpeechStatus);
const decodeTranscription = Schema.decodeUnknownSync(EnvironmentSpeechTranscriptionResult);
const readyStatus = {
  supported: true,
  state: "ready",
  modelId: "handy-computer/moonshine-tiny-gguf",
  model: "Moonshine Tiny",
  size: 35_466_912,
  supportsStreaming: false,
  supportsTranslation: true,
  acceleration: "auto",
  modelUnloadTimeout: "min_15",
  gpuDevices: [],
};

describe("environment speech contracts", () => {
  it("accepts supported and unsupported statuses", () => {
    expect(decodeStatus(readyStatus)).toEqual(readyStatus);
    expect(decodeStatus({ supported: false, reason: "unsupported platform" })).toEqual({
      supported: false,
      reason: "unsupported platform",
    });
  });

  it.each(["acceleration", "modelUnloadTimeout", "gpuDevices", "supportsTranslation"])(
    "rejects a supported status missing %s",
    (field) => {
      const incomplete = Object.fromEntries(
        Object.entries(readyStatus).filter(([key]) => key !== field),
      );
      expect(() => decodeStatus(incomplete)).toThrow();
    },
  );

  it("bounds request vocabulary and rejects duplicate aliases", () => {
    const decode = Schema.decodeUnknownSync(SpeechTranscriptionOptions);
    expect(() =>
      decode({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: [{ term: "x".repeat(51), aliases: [] }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: [
          { term: "MiniMax", aliases: ["mini max"] },
          { term: "Other", aliases: ["MINI MAX"] },
        ],
      }),
    ).toThrow();
  });

  it("accepts a transcription result", () => {
    expect(decodeTranscription({ text: "hello" })).toEqual({ text: "hello" });
  });
});
