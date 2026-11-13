import {
  SpeechSynthesisError,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
  type SpeechSynthesisCatalog,
} from "@t3tools/contracts";
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
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { MAX_SYNTHESIS_BYTES, speechWave } from "./synthesisAudio.ts";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { applySpeechAliases } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import { decodeSpeechPcm, SpeechInvalidAudioError } from "./SpeechService.ts";

const isSynthesisError = Schema.is(SpeechSynthesisError);

const readSynthesisBody = Effect.fn("CloudSpeech.readSynthesisBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
  provider: SpeechSynthesisProvider,
  limit: number,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const unavailable = (cause?: unknown) =>
    isSynthesisError(cause)
      ? cause
      : new SpeechSynthesisError({ provider, reason: "unavailable", cause });
  yield* response.stream.pipe(
    Stream.runForEach((chunk) => {
      size += chunk.byteLength;
      if (size > limit) return Effect.fail(unavailable());
      chunks.push(chunk);
      return Effect.void;
    }),
    Effect.mapError(unavailable),
  );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

const decodeXaiSynthesisCatalog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ voices: Schema.Array(Schema.Struct({ voice_id: Schema.String })) }),
  ),
);

const decodeOpenRouterSynthesisCatalog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.optionalKey(Schema.String),
          supported_voices: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
        }),
      ),
    }),
  ),
);

const endpoints = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe" },
  xai: { url: "https://api.x.ai/v1/stt", model: "grok-voice-transcribe-2.0" },
  openrouter: { url: "https://openrouter.ai/api/v1/audio/transcriptions" },
};
const OPENROUTER_CATALOG_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription&zdr=true";
const isApiKey = Schema.is(CloudSpeechApiKey);
const isModelId = Schema.is(CloudSpeechModelId);
const sameCredential = Schema.toEquivalence(SettingsSecretValue);
const OpenRouterCatalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) })),
});
const decodeNativeCodexAuth = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: Schema.optionalKey(Schema.Literals(["chatgpt", "chatgptAuthTokens"])),
      tokens: Schema.Struct({
        access_token: Schema.RedactedFromValue(
          Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^\S+$/)),
        ),
        account_id: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\S+$/))),
      }),
    }),
  ),
);

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
    readonly synthesisModels: (
      provider: SpeechSynthesisProvider,
    ) => Effect.Effect<SpeechSynthesisCatalog, SpeechSynthesisError | ServerSettingsError>;
    readonly synthesize: (
      provider: SpeechSynthesisProvider,
      request: SpeechSynthesisRequest,
    ) => Effect.Effect<Uint8Array, SpeechSynthesisError | ServerSettingsError>;
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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const subscriptionAuth = Effect.fn("CloudSpeech.subscriptionAuth")(function* () {
      const environment = yield* HostProcess.Environment;
      const home = yield* HostProcess.HomeDirectory;
      const directory = environment.CODEX_HOME?.trim() || path.join(home, ".codex");
      return yield* fs.readFileString(path.join(directory, "auth.json")).pipe(
        Effect.flatMap(decodeNativeCodexAuth),
        Effect.map((value) => value.tokens),
        Effect.mapError(
          (cause) =>
            new SpeechSynthesisError({
              provider: "chatgpt",
              reason: "subscription-login-required",
              cause,
            }),
        ),
      );
    });
    const credentials = settings.getSettings.pipe(
      Effect.map((value) => value.cloudSpeechCredentials),
    );
    const configured = credentials.pipe(
      Effect.map(({ openai, xai, openrouter }) => ({
        openai: Boolean(openai),
        xai: Boolean(xai),
        openrouter: Boolean(openrouter),
      })),
    );
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
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
    const synthesisModels = Effect.fn("CloudSpeech.synthesisModels")(
      function* (provider: SpeechSynthesisProvider) {
        if (provider === "chatgpt") {
          const signedIn = yield* Effect.isSuccess(subscriptionAuth());
          return {
            models: signedIn
              ? [
                  {
                    id: "chatgpt-read-aloud",
                    name: "ChatGPT read aloud",
                    voices: [],
                  },
                ]
              : [],
          };
        }
        if (provider === "xai") {
          const source = (yield* credentials).xai;
          if (!source) return yield* new SpeechSynthesisError({ provider, reason: "missing-key" });
          if (isSecretReference(source)) yield* resolver.invalidate([source]);
          const key = yield* requireSettingsSecret(resolver, source).pipe(
            Effect.mapError(
              (cause) => new SpeechSynthesisError({ provider, reason: "unreadable-key", cause }),
            ),
          );
          if (!isApiKey(key))
            return yield* new SpeechSynthesisError({ provider, reason: "unreadable-key" });
          const current = (yield* credentials).xai;
          if (!current || !sameCredential(source, current))
            return yield* new SpeechSynthesisError({ provider, reason: "key-changed" });
          const unavailable = (cause?: unknown) =>
            isSynthesisError(cause)
              ? cause
              : new SpeechSynthesisError({ provider, reason: "unavailable", cause });
          const response = yield* execute(
            HttpClientRequest.get("https://api.x.ai/v1/tts/voices").pipe(
              HttpClientRequest.bearerToken(Redacted.make(key)),
            ),
          ).pipe(Effect.mapError(unavailable));
          if (response.status !== 200) return yield* unavailable();
          const catalog = yield* decodeXaiSynthesisCatalog(
            new TextDecoder().decode(yield* readSynthesisBody(response, provider, 1024 * 1024)),
          ).pipe(Effect.mapError(unavailable));
          return {
            models: [
              {
                id: "grok-tts",
                name: "Grok TTS",
                voices: catalog.voices.map((voice) => voice.voice_id),
              },
            ],
          };
        }
        const unavailable = (cause?: unknown) =>
          isSynthesisError(cause)
            ? cause
            : new SpeechSynthesisError({ provider, reason: "unavailable", cause });
        const response = yield* execute(
          HttpClientRequest.get("https://openrouter.ai/api/v1/models?output_modalities=speech"),
        ).pipe(Effect.mapError(unavailable));
        if (response.status !== 200) return yield* unavailable();
        const catalog = yield* decodeOpenRouterSynthesisCatalog(
          new TextDecoder().decode(yield* readSynthesisBody(response, provider, 1024 * 1024)),
        ).pipe(Effect.mapError(unavailable));
        return {
          models: catalog.data.map((model) => ({
            id: model.id,
            name: model.name || model.id,
            voices: model.supported_voices ?? [],
          })),
        };
      },
      (effect, provider) =>
        effect.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(1024 * 1024)),
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail(new SpeechSynthesisError({ provider, reason: "unavailable" })),
          }),
        ),
    );
    const openRouterSpeechModels = yield* Effect.cachedWithTTL(
      synthesisModels("openrouter"),
      (exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0),
    );
    const synthesize = Effect.fn("CloudSpeech.synthesize")(
      function* (provider: SpeechSynthesisProvider, request: SpeechSynthesisRequest) {
        const unavailable = (cause?: unknown) =>
          isSynthesisError(cause)
            ? cause
            : new SpeechSynthesisError({ provider, reason: "unavailable", cause });
        let key: string | undefined;
        let source: SettingsSecretValue | undefined;
        const subscription = provider === "chatgpt" ? yield* subscriptionAuth() : null;
        if (subscription) key = Redacted.value(subscription.access_token);
        if (provider !== "chatgpt") {
          source = (yield* credentials)[provider];
          if (!source) return yield* new SpeechSynthesisError({ provider, reason: "missing-key" });
          if (isSecretReference(source)) yield* resolver.invalidate([source]);
          key = yield* requireSettingsSecret(resolver, source).pipe(
            Effect.mapError(
              (cause) => new SpeechSynthesisError({ provider, reason: "unreadable-key", cause }),
            ),
          );
          if (!isApiKey(key))
            return yield* new SpeechSynthesisError({ provider, reason: "unreadable-key" });
          const current = (yield* credentials)[provider];
          if (!current || !sameCredential(source, current))
            return yield* new SpeechSynthesisError({ provider, reason: "key-changed" });
        }
        const base =
          provider === "chatgpt"
            ? "https://chatgpt.com/backend-api"
            : provider === "xai"
              ? "https://api.x.ai/v1"
              : "https://openrouter.ai/api/v1";
        if (!request.model && provider === "openrouter")
          return yield* new SpeechSynthesisError({ provider, reason: "model-unavailable" });
        const voice =
          request.voice ||
          (provider === "openrouter"
            ? (yield* openRouterSpeechModels).models.find((model) => model.id === request.model)
                ?.voices[0]
            : undefined);
        // Gemini and HeyGen only support PCM; use self-describing MP3 elsewhere.
        const format =
          request.model.startsWith("google/gemini-") || request.model.startsWith("heygen/")
            ? "pcm"
            : "mp3";
        const body =
          provider === "chatgpt"
            ? { text: request.text }
            : provider === "xai"
              ? {
                  text: request.text,
                  voice_id: request.voice || "eve",
                  language: request.language,
                  speed: request.speed,
                  output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
                }
              : {
                  input: request.text,
                  model: request.model,
                  ...(voice ? { voice } : {}),
                  response_format: format,
                };
        if (provider !== "chatgpt") {
          const current = (yield* credentials)[provider];
          if (!current || !source || !sameCredential(source, current))
            return yield* new SpeechSynthesisError({ provider, reason: "key-changed" });
        }
        if (subscription) {
          const current = yield* subscriptionAuth();
          if (
            Redacted.value(current.access_token) !== key ||
            current.account_id !== subscription.account_id
          )
            return yield* new SpeechSynthesisError({ provider, reason: "key-changed" });
        }
        const response = yield* execute(
          HttpClientRequest.post(
            `${base}/${provider === "chatgpt" ? "read-aloud/synthesize" : provider === "xai" ? "tts" : "audio/speech"}`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
            (request) =>
              subscription?.account_id
                ? HttpClientRequest.setHeader(
                    "ChatGPT-Account-Id",
                    subscription.account_id,
                  )(request)
                : request,
            (request) =>
              key ? HttpClientRequest.bearerToken(Redacted.make(key))(request) : request,
          ),
        ).pipe(Effect.mapError(unavailable));
        if (response.status < 200 || response.status >= 300)
          return yield* new SpeechSynthesisError({
            provider,
            reason:
              provider === "chatgpt" && response.status === 401
                ? "subscription-expired"
                : provider === "chatgpt" && response.status === 403
                  ? "subscription-unavailable"
                  : response.status === 401 || response.status === 403
                    ? "rejected-key"
                    : response.status === 429
                      ? "rate-limit"
                      : "unavailable",
          });
        const bytes = yield* readSynthesisBody(response, provider, MAX_SYNTHESIS_BYTES);
        if (!bytes.length || bytes.length > MAX_SYNTHESIS_BYTES) return yield* unavailable();
        if (format === "pcm" && provider === "openrouter") {
          const contentType = response.headers["content-type"] ?? "";
          const rate = Number(/\brate=([^;\s]+)/.exec(contentType)?.[1] ?? "24000");
          const channels = Number(/\bchannels=(\d+)/.exec(contentType)?.[1] ?? "1");
          return yield* Effect.try({
            try: () => speechWave(bytes, rate, channels),
            catch: unavailable,
          });
        }
        return bytes;
      },
      (effect, provider) =>
        effect.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            ByteSize.bytes(MAX_SYNTHESIS_BYTES),
          ),
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () =>
              Effect.fail(new SpeechSynthesisError({ provider, reason: "unavailable" })),
          }),
        ),
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
        const request = HttpClientRequest.post(endpoints[provider].url).pipe(
          HttpClientRequest.bearerToken(Redacted.make(key)),
          provider === "openrouter"
            ? openRouterBody(model!, audio, language)
            : audioBody(provider, audio, language, options),
        );
        const unavailable = () => new CloudSpeechError({ provider, reason: "unavailable" });
        // A catalog fetch or vault lookup may have outlived the credential it started with.
        const current = (yield* credentials)[provider];
        if (!current || !sameCredential(source, current))
          return yield* new CloudSpeechError({
            provider,
            reason: current ? "key-changed" : "missing-key",
          });
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
        const { text } = yield* HttpClientResponse.schemaBodyJson(
          EnvironmentSpeechTranscriptionResult,
        )(response).pipe(Effect.mapError(unavailable));
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
    return CloudSpeech.of({ configured, models, setKey, transcribe, synthesisModels, synthesize });
  }),
);
