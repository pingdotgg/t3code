import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvironmentSpeechStatus, EnvironmentSpeechTranscriptionResult } from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(EnvironmentSpeechStatus);
const decodeTranscription = Schema.decodeUnknownSync(EnvironmentSpeechTranscriptionResult);
const readyStatus = {
  supported: true,
  state: "ready",
  modelId: "handy-computer/moonshine-tiny-gguf",
  model: "Moonshine Tiny",
  size: 35_466_912,
  supportsStreaming: false,
  acceleration: "auto",
  language: "auto",
  effectiveLanguage: "auto",
  modelUnloadTimeout: "min_15",
  gpuDevices: [],
  customWords: [{ term: "T3 Code", aliases: ["T3 codes"] }],
  removeFillerWords: false,
};

describe("environment speech contracts", () => {
  it("accepts supported and unsupported statuses", () => {
    expect(decodeStatus(readyStatus)).toEqual(readyStatus);
    expect(decodeStatus({ supported: false, reason: "unsupported platform" })).toEqual({
      supported: false,
      reason: "unsupported platform",
    });
  });

  it.each([
    "language",
    "effectiveLanguage",
    "acceleration",
    "modelUnloadTimeout",
    "gpuDevices",
    "customWords",
    "removeFillerWords",
  ])("rejects a supported status missing %s", (field) => {
    const incomplete = Object.fromEntries(
      Object.entries(readyStatus).filter(([key]) => key !== field),
    );
    expect(() => decodeStatus(incomplete)).toThrow();
  });

  it("bounds vocabulary entries and rejects duplicate aliases", () => {
    expect(() =>
      decodeStatus({
        ...readyStatus,
        customWords: [{ term: "x".repeat(51), aliases: [] }],
      }),
    ).toThrow();
    expect(() =>
      decodeStatus({
        ...readyStatus,
        customWords: [
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
