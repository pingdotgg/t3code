import {
  CloudSpeechApiKey,
  CloudSpeechError,
  CloudSpeechModel,
  CloudSpeechModelId,
  SettingsSecretValue,
  isSecretReference,
  type SecretReference,
  type ServerSettingsError,
  type CloudSpeechKeys,
  type CloudSpeechProvider,
  EnvironmentSpeechTranscriptionResult,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { applySpeechAliases } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import { decodeSpeechPcm, SpeechInvalidAudioError } from "./SpeechService.ts";

const endpoints = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe" },
  xai: { url: "https://api.x.ai/v1/stt", model: "grok-voice-transcribe-2.0" },
  soniox: { url: "https://api.soniox.com/v1/files" },
  openrouter: { url: "https://openrouter.ai/api/v1/audio/transcriptions" },
};
const OPENROUTER_CATALOG_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription&zdr=true";
const isCloudSpeechError = Schema.is(CloudSpeechError);
const isApiKey = Schema.is(CloudSpeechApiKey);
const isModelId = Schema.is(CloudSpeechModelId);
const sameCredential = Schema.toEquivalence(SettingsSecretValue);
const OpenRouterCatalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) })),
});

function wave(samples: Float32Array) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (at: number, value: string) =>
    new Uint8Array(buffer, at, 4).set(new TextEncoder().encode(value));
  tag(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, buffer.byteLength - 44, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

function audioBody(
  provider: "openai" | "xai",
  audio: ArrayBuffer,
  language: string,
  options: SpeechTranscriptionOptions,
) {
  const form = new FormData();
  form.set("model", endpoints[provider].model);
  if (language !== "auto") form.set(provider === "openai" ? "languages[]" : "language", language);
  for (const { term } of options.speechCustomWords) {
    if (provider === "openai" && /[<>\r\n]/.test(term)) continue;
    form.append(provider === "openai" ? "keywords[]" : "keyterm", term);
  }
  if (provider === "xai") {
    if (language !== "auto") form.set("format", "true");
    form.set(
      "filler_words",
      String(!options.speechRemoveFillerWords || Boolean(options.speechCorrectionWord)),
    );
    if (!options.speechSilenceFiltering) form.set("vad_threshold", "0");
  }
  // xAI ignores options that follow the file part.
  form.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  return HttpClientRequest.bodyFormData(form);
}

function openRouterBody(model: string, audio: ArrayBuffer, language: string) {
  return HttpClientRequest.bodyJsonUnsafe({
    model,
    input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
    ...(language !== "auto" ? { language } : {}),
    provider: { zdr: true },
  });
}

export class CloudSpeech extends Context.Service<
  CloudSpeech,
  {
    readonly configured: Effect.Effect<CloudSpeechKeys, ServerSettingsError>;
    /** OpenRouter's public transcription catalog, cached briefly on this server. */
    readonly models: Effect.Effect<ReadonlyArray<CloudSpeechModel>, CloudSpeechError>;
    readonly setKey: (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) => Effect.Effect<void, ServerSettingsError>;
    readonly transcribe: (
      provider: CloudSpeechProvider,
      pcm: Uint8Array,
      options: SpeechTranscriptionOptions,
      model?: string | undefined,
    ) => Effect.Effect<string, CloudSpeechError | SpeechInvalidAudioError | ServerSettingsError>;
  }
>()("t3/speech/CloudSpeech") {}

export const layer = Layer.effect(
  CloudSpeech,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const http = yield* HttpClient.HttpClient;
    const credentials = settings.getSettings.pipe(
      Effect.map((value) => value.cloudSpeechCredentials),
    );
    const configured = credentials.pipe(
      Effect.map(({ openai, xai, openrouter, soniox }) => ({
        openai: Boolean(openai),
        xai: Boolean(xai),
        openrouter: Boolean(openrouter),
        soniox: Boolean(soniox),
      })),
    );
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
    const sonioxTranscribe = Effect.fn("CloudSpeech.sonioxTranscribe")(function* (
      key: string,
      audio: ArrayBuffer,
      language: string,
      options: SpeechTranscriptionOptions,
    ) {
      const unavailable = () => new CloudSpeechError({ provider: "soniox", reason: "unavailable" });
      const request = Effect.fn("CloudSpeech.sonioxRequest")(function* (
        input: HttpClientRequest.HttpClientRequest,
      ) {
        const response = yield* execute(
          input.pipe(HttpClientRequest.bearerToken(Redacted.make(key))),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(unavailable()),
          }),
          Effect.mapError(unavailable),
        );
        if (response.status < 200 || response.status >= 300)
          return yield* new CloudSpeechError({
            provider: "soniox",
            reason:
              response.status === 429
                ? "rate-limit"
                : [401, 402, 403].includes(response.status)
                  ? "rejected-key"
                  : "unavailable",
          });
        return response;
      });
      const resource = Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) });
      const cleanup = (path: string) =>
        request(HttpClientRequest.delete(`https://api.soniox.com/v1/${path}`)).pipe(
          Effect.timeout("5 seconds"),
          Effect.catch(() => Effect.logWarning("Could not delete temporary Soniox speech data.")),
          Effect.asVoid,
        );
      const form = new FormData();
      form.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
      const file = yield* Effect.acquireRelease(
        request(
          HttpClientRequest.post(endpoints.soniox.url).pipe(HttpClientRequest.bodyFormData(form)),
        ).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(resource)),
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(unavailable()),
          }),
          Effect.mapError((error) => (isCloudSpeechError(error) ? error : unavailable())),
        ),
        ({ id }) => cleanup(`files/${encodeURIComponent(id)}`),
      );
      const job = yield* Effect.acquireRelease(
        request(
          HttpClientRequest.post("https://api.soniox.com/v1/transcriptions").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              model: "stt-async-v6",
              file_id: file.id,
              ...(language !== "auto" ? { language_hints: [language] } : {}),
              context: { terms: options.speechCustomWords.map(({ term }) => term) },
            }),
          ),
        ).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(resource)),
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(unavailable()),
          }),
          Effect.mapError((error) => (isCloudSpeechError(error) ? error : unavailable())),
        ),
        ({ id }) => cleanup(`transcriptions/${encodeURIComponent(id)}`),
      );
      const url = `https://api.soniox.com/v1/transcriptions/${encodeURIComponent(job.id)}`;
      const status = yield* request(HttpClientRequest.get(url)).pipe(
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(
            Schema.Struct({
              status: Schema.Literals(["queued", "processing", "completed", "error"]),
            }),
          ),
        ),
        Effect.mapError((error) => (isCloudSpeechError(error) ? error : unavailable())),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: ({ status }) => status === "completed" || status === "error",
        }),
      );
      if (status.status === "error") return yield* unavailable();
      const result = yield* request(HttpClientRequest.get(`${url}/transcript`)).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(EnvironmentSpeechTranscriptionResult)),
        Effect.mapError((error) => (isCloudSpeechError(error) ? error : unavailable())),
      );
      return result.text;
    }, Effect.scoped);
    const fetchCatalog = Effect.fn("CloudSpeech.catalog")(function* () {
      const unavailable = () =>
        new CloudSpeechError({ provider: "openrouter", reason: "unavailable" });
      const response = yield* execute(HttpClientRequest.get(OPENROUTER_CATALOG_URL)).pipe(
        Effect.mapError(unavailable),
      );
      if (response.status < 200 || response.status >= 300) return yield* unavailable();
      const { data } = yield* HttpClientResponse.schemaBodyJson(OpenRouterCatalog)(response).pipe(
        Effect.mapError(unavailable),
      );
      return data.flatMap(({ id, name }) =>
        isModelId(id) ? [{ id, name: name?.trim() || id }] : [],
      );
    });
    // The catalog is public, so the cache holds no credential or consent state.
    const models = yield* Effect.cachedWithTTL(
      fetchCatalog().pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(new CloudSpeechError({ provider: "openrouter", reason: "unavailable" })),
        }),
      ),
      (exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0),
    );
    const setKey = Effect.fn("CloudSpeech.setKey")(function* (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) {
      yield* settings.updateSettings({
        cloudSpeechCredentials: {
          [provider]: Redacted.isRedacted(key) ? Redacted.value(key) : (key ?? ""),
        },
      });
    });
    const transcribe = Effect.fn("CloudSpeech.transcribe")(
      function* (
        provider: CloudSpeechProvider,
        pcm: Uint8Array,
        options: SpeechTranscriptionOptions,
        model?: string,
      ) {
        const source = (yield* credentials)[provider];
        if (!source) return yield* new CloudSpeechError({ provider, reason: "missing-key" });
        if (provider === "openrouter" && (!model || !isModelId(model)))
          return yield* new CloudSpeechError({ provider, reason: "model-unavailable" });
        const samples = yield* Effect.try({
          try: () => decodeSpeechPcm(pcm),
          catch: () =>
            new SpeechInvalidAudioError({
              byteLength: pcm.byteLength,
              message: "Invalid PCM audio.",
            }),
        });
        const language = effectiveSpeechLanguage(cloudSpeechLanguages, options.speechLanguage);
        if (provider === "openrouter" && !(yield* models).some((entry) => entry.id === model))
          return yield* new CloudSpeechError({ provider, reason: "model-unavailable" });
        // A vault that locked since the last recording must not authorize a new upload.
        if (isSecretReference(source)) yield* resolver.invalidate([source]);
        const unreadable = () => new CloudSpeechError({ provider, reason: "unreadable-key" });
        const key = yield* requireSettingsSecret(resolver, source).pipe(
          Effect.mapError(unreadable),
        );
        if (!isApiKey(key)) return yield* unreadable();
        const audio = wave(samples);
        const unavailable = () => new CloudSpeechError({ provider, reason: "unavailable" });
        // A catalog fetch or vault lookup may have outlived the credential it started with.
        const current = (yield* credentials)[provider];
        if (!current || !sameCredential(source, current))
          return yield* new CloudSpeechError({
            provider,
            reason: current ? "key-changed" : "missing-key",
          });
        const text =
          provider === "soniox"
            ? yield* sonioxTranscribe(key, audio, language, options)
            : yield* Effect.gen(function* () {
                const request = HttpClientRequest.post(endpoints[provider].url).pipe(
                  HttpClientRequest.bearerToken(Redacted.make(key)),
                  provider === "openrouter"
                    ? openRouterBody(model!, audio, language)
                    : audioBody(provider, audio, language, options),
                );
                const response = yield* execute(request).pipe(Effect.mapError(unavailable));
                if (response.status < 200 || response.status >= 300)
                  return yield* new CloudSpeechError({
                    provider,
                    reason:
                      response.status === 429
                        ? "rate-limit"
                        : [401, 402, 403].includes(response.status)
                          ? "rejected-key"
                          : response.status === 404 && provider === "openrouter"
                            ? "model-unavailable"
                            : "unavailable",
                  });
                const result = yield* HttpClientResponse.schemaBodyJson(
                  EnvironmentSpeechTranscriptionResult,
                )(response).pipe(Effect.mapError(unavailable));
                return result.text;
              });
        const corrected = applySpeechAliases(text, options.speechCustomWords);
        return (
          options.speechRemoveFillerWords
            ? removeSpeechFillerWords(corrected, language, options.speechCorrectionWord)
            : corrected
        ).trim();
      },
      (effect, provider) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () => Effect.fail(new CloudSpeechError({ provider, reason: "unavailable" })),
          }),
        ),
    );
    return CloudSpeech.of({ configured, models, setKey, transcribe });
  }),
);
