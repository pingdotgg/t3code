import { describe, expect, it } from "vite-plus/test";
import { resolveDesktopTranscript } from "./desktopDictationDraft";
import { encodeDictationWav } from "./desktopVoiceCapture";
import type { VoiceDraftSnapshot } from "@t3tools/client-runtime/voice-input";
const draft = (text: string, cursor: number): VoiceDraftSnapshot => ({
  ownerKey: "local:thread",
  text,
  selection: { start: cursor, end: cursor },
  revision: 1,
});
describe("desktop dictation draft ownership", () => {
  it("inserts without overwriting text typed after the captured cursor", () => {
    const result = resolveDesktopTranscript(
      draft("Fix the ", 8),
      { ...draft("Fix the cache", 13), revision: 2 },
      "parser",
      "en",
    );
    expect(result.kind).toBe("commit");
    if (result.kind === "commit") expect(result.text).toBe("Fix the parser cache");
  });
  it("rebases over an edit before the captured insertion", () => {
    const result = resolveDesktopTranscript(
      draft("a end", 5),
      { ...draft("longer end", 10), revision: 2 },
      "now",
      "en",
    );
    expect(result.kind).toBe("commit");
    if (result.kind === "commit") expect(result.text).toBe("longer end now");
  });
  it("retains a transcript for review when its insertion anchor was removed", () => {
    expect(
      resolveDesktopTranscript(
        draft("one two three", 6),
        { ...draft("one other", 9), revision: 2 },
        "voice",
        "en",
      ),
    ).toEqual({ kind: "stale" });
  });
  it("never inserts into a different composer or replaces selected draft text", () => {
    expect(
      resolveDesktopTranscript(
        draft("", 0),
        { ...draft("", 0), ownerKey: "remote:other" },
        "voice",
        "en",
      ),
    ).toEqual({ kind: "stale" });
    const captured = { ...draft("keep me", 0), selection: { start: 0, end: 7 } };
    const result = resolveDesktopTranscript(captured, captured, "voice", "en");
    expect(result.kind).toBe("commit");
    if (result.kind === "commit") expect(result.text).toBe("voice keep me");
  });
  it("encodes bounded mono PCM with clipped samples and a valid sample rate", () => {
    const wav = encodeDictationWav([new Float32Array([2, -2, 0])], 16000);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(50);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(0);
  });
});
