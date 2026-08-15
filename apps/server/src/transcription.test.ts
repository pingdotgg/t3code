import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import {
  forwardVoiceTranscription,
  listVoiceTranscriptionModels,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  readTranscriptionAudio,
  resolveTranscriptionProvider,
  transcriptionEnvironmentApiKeyStatus,
  transcriptionProviderConfig,
} from "./transcription.ts";

describe("transcription providers", () => {
  it("uses fixed OpenAI and Groq configurations", () => {
    expect(resolveTranscriptionProvider("openai")).toBe("openai");
    expect(transcriptionProviderConfig("openai")).toEqual({
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      modelsEndpoint: "https://api.openai.com/v1/models",
      apiKeyEnvironmentVariable: "OPENAI_API_KEY",
    });
    expect(resolveTranscriptionProvider("groq")).toBe("groq");
    expect(transcriptionProviderConfig("groq")).toEqual({
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      modelsEndpoint: "https://api.groq.com/openai/v1/models",
      apiKeyEnvironmentVariable: "GROQ_API_KEY",
    });
    expect(resolveTranscriptionProvider("custom")).toBeNull();
  });

  it.effect("loads accessible transcription models with the provider API key", () =>
    Effect.gen(function* () {
      let capturedRequest: HttpClientRequest.HttpClientRequest | undefined;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          capturedRequest = request;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [
                { id: "gpt-4o" },
                { id: " whisper-1 " },
                { id: "gpt-4o-mini-transcribe" },
                { id: "gpt-4o-mini-transcribe" },
              ],
            }),
          );
        }),
      );

      const models = yield* listVoiceTranscriptionModels({
        provider: "openai",
        apiKey: "client-openai-key",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(models).toEqual(["gpt-4o-mini-transcribe", "whisper-1"]);
      expect(capturedRequest?.url).toBe("https://api.openai.com/v1/models");
      expect(capturedRequest?.headers.authorization).toBe("Bearer client-openai-key");
    }),
  );

  it.effect("uses a provider API key from the server environment", () =>
    Effect.gen(function* () {
      let capturedRequest: HttpClientRequest.HttpClientRequest | undefined;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          capturedRequest = request;
          return HttpClientResponse.fromWeb(request, Response.json({ text: " groq transcript " }));
        }),
      );

      const transcript = yield* forwardVoiceTranscription({
        audio: new Uint8Array([1, 2, 3]),
        audioMimeType: "audio/webm;codecs=opus",
        provider: "groq",
        apiKey: "",
        model: "whisper-large-v3",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(yield* transcriptionEnvironmentApiKeyStatus("groq")).toBe(true);
      expect(yield* transcriptionEnvironmentApiKeyStatus("openai")).toBe(false);
      expect(transcript).toBe("groq transcript");
      expect(capturedRequest?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
      expect(capturedRequest?.headers.authorization).toBe("Bearer env-groq-key");
      expect(capturedRequest?.body._tag).toBe("FormData");
      if (capturedRequest?.body._tag === "FormData") {
        expect(capturedRequest.body.formData.get("model")).toBe("whisper-large-v3");
        expect(capturedRequest.body.formData.get("file")).toBeInstanceOf(Blob);
      }
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GROQ_API_KEY: "env-groq-key" } })),
      ),
    ),
  );
});

describe("readTranscriptionAudio", () => {
  it.effect("combines streamed audio chunks", () =>
    Effect.gen(function* () {
      const audio = yield* readTranscriptionAudio(
        Stream.make(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
      );
      expect(Array.from(audio)).toEqual([1, 2, 3, 4]);
    }),
  );

  it.effect("stops when streamed audio exceeds the limit", () =>
    Effect.gen(function* () {
      const error = yield* readTranscriptionAudio(
        Stream.make(new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES), new Uint8Array([1])),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("TranscriptionAudioTooLargeError");
    }),
  );
});
