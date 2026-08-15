import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  listVoiceTranscriptionModels,
  transcribeVoiceRecording,
  voiceTranscriptionRequestHeaders,
} from "./voiceTranscription";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voiceTranscriptionRequestHeaders", () => {
  it("sends a client-provided OpenAI key", () => {
    expect(
      voiceTranscriptionRequestHeaders("audio/webm", {
        provider: "openai",
        apiKey: " openai-key ",
        model: " gpt-4o-mini-transcribe ",
      }),
    ).toEqual({
      "content-type": "audio/webm",
      "x-t3-transcription-provider": "openai",
      "x-t3-transcription-model": "gpt-4o-mini-transcribe",
      "x-t3-transcription-api-key": "openai-key",
    });
  });

  it("omits an empty key so the server can use the provider environment variable", () => {
    expect(
      voiceTranscriptionRequestHeaders("audio/mp4", {
        provider: "groq",
        apiKey: "",
        model: "whisper-large-v3",
      }),
    ).toEqual({
      "content-type": "audio/mp4",
      "x-t3-transcription-provider": "groq",
      "x-t3-transcription-model": "whisper-large-v3",
    });
  });
});

describe("listVoiceTranscriptionModels", () => {
  it("loads the provider models through the connected T3 server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        models: ["gpt-4o-mini-transcribe", "whisper-1"],
      }),
    );
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost:3773/settings",
        origin: "http://localhost:3773",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listVoiceTranscriptionModels({ provider: "openai", apiKey: "client-key" }),
    ).resolves.toEqual(["gpt-4o-mini-transcribe", "whisper-1"]);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:3773/api/transcription/models");
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
    expect(init.headers).toMatchObject({
      "x-t3-transcription-api-key": "client-key",
      "x-t3-transcription-provider": "openai",
    });
  });

  it("uploads audio through the owned primary HTTP layer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: " hello " }));
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost:3773/thread",
        origin: "http://localhost:3773",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeVoiceRecording(new Blob(["audio"], { type: "audio/webm" }), {
        provider: "openai",
        apiKey: "client-key",
        model: "gpt-4o-transcribe",
      }),
    ).resolves.toBe("hello");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:3773/api/transcription");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(init.headers).toMatchObject({
      "content-type": "audio/webm",
      "x-t3-transcription-api-key": "client-key",
      "x-t3-transcription-model": "gpt-4o-transcribe",
      "x-t3-transcription-provider": "openai",
    });
  });
});
