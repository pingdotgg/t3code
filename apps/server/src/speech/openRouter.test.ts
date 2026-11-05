import { describe, expect, it } from "vite-plus/test";

import { encodeSpeechWav, parseSpeechCloudModels } from "./openRouter.ts";

describe("parseSpeechCloudModels", () => {
  it("keeps OpenRouter's order, moving preferred models ahead only when listed", () => {
    const models = parseSpeechCloudModels({
      data: [
        { id: "openai/whisper-1", name: "Whisper", pricing: { prompt: "0.0001", completion: "0" } },
        { id: "meta/muse-voice-transcribe-1.0", name: "Muse" },
        { id: "deepgram/nova-3" },
        { id: "google/gemini-3.5-transcribe", name: "Gemini" },
        { name: "missing id" },
      ],
    });
    expect(models.map((model) => model.id)).toEqual([
      "google/gemini-3.5-transcribe",
      "meta/muse-voice-transcribe-1.0",
      "openai/whisper-1",
      "deepgram/nova-3",
    ]);
    expect(models.find((model) => model.id === "deepgram/nova-3")).toEqual({
      id: "deepgram/nova-3",
      name: "deepgram/nova-3",
      description: "",
      pricing: { prompt: "0", completion: "0" },
    });
  });
});

describe("encodeSpeechWav", () => {
  it("writes 16 kHz mono 16-bit PCM and clamps out-of-range samples", () => {
    const wav = encodeSpeechWav(new Float32Array([0, 1, -1, 2]));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });
});
