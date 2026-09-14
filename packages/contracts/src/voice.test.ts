import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { VoiceStartInput, VoiceStartResult, VoiceStopInput } from "./voice.ts";

const decodeStart = Schema.decodeUnknownSync(VoiceStartInput);
const decodeResult = Schema.decodeUnknownSync(VoiceStartResult);
const decodeStop = Schema.decodeUnknownSync(VoiceStopInput);

describe("Live voice negotiation", () => {
  it("preserves SDP line endings and opaque upstream session identifiers", () => {
    const sdp = "v=0\r\na=ice-ufrag:example\r\n";
    expect(decodeStart({ threadId: "thread-1", sdp }).sdp).toBe(sdp);
    expect(decodeResult({ sessionId: "live_opaque-id", sdp })).toEqual({
      sessionId: "live_opaque-id",
      sdp,
    });
  });

  it("rejects empty or excessive negotiation payloads before an upstream call", () => {
    expect(() => decodeStart({ threadId: "thread-1", sdp: "" })).toThrow();
    expect(() => decodeStart({ threadId: "thread-1", sdp: "x".repeat(65_537) })).toThrow();
    expect(() => decodeStop({ sessionId: " " })).toThrow();
  });
});
