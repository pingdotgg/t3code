import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DesktopMicrophoneSettingsSchema,
  DesktopSpeechEventSchema,
  DesktopSpeechStatusSchema,
} from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(DesktopSpeechStatusSchema);
const decodeEvent = Schema.decodeUnknownSync(DesktopSpeechEventSchema);

describe("desktop speech contracts", () => {
  it("accepts a ready status", () => {
    expect(decodeStatus({ supported: true, state: "ready" })).toEqual({
      supported: true,
      state: "ready",
    });
  });

  it("rejects negative model progress", () => {
    expect(() =>
      decodeEvent({
        type: "download-progress",
        downloaded: -1,
        total: 10,
      }),
    ).toThrow();
  });

  it("accepts desktop microphone settings", () => {
    expect(
      Schema.decodeUnknownSync(DesktopMicrophoneSettingsSchema)({
        devices: ["Built-in Microphone", "USB Microphone"],
        selected: "USB Microphone",
      }),
    ).toEqual({
      devices: ["Built-in Microphone", "USB Microphone"],
      selected: "USB Microphone",
    });
  });
});
