import {
  CodexSettings,
  ProviderInstanceId,
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
import * as Stream from "effect/Stream";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { applySpeechAliases } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import { decodeSpeechPcm, SpeechInvalidAudioError } from "./SpeechService.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeNativeLogin = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: Schema.optionalKey(Schema.String),
      tokens: Schema.Struct({ access_token: CloudSpeechApiKey, account_id: CloudSpeechApiKey }),
    }),
  ),
);
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EnvironmentSpeechTranscriptionResult),
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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseEnv = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const nativeLogin = Effect.fn("CloudSpeech.nativeLogin")(function* () {
      const instance = (yield* settings.getSettings).providerInstances[
        ProviderInstanceId.make("codex")
      ];
      if (instance && instance.driver !== "codex")
        return yield* new CloudSpeechError({ provider: "chatgpt", reason: "missing-key" });
      const config = yield* decodeCodexSettings(instance?.config ?? {}).pipe(
        Effect.mapError(
          () => new CloudSpeechError({ provider: "chatgpt", reason: "unreadable-key" }),
        ),
      );
      if (config.setupMode === "managed")
        return yield* new CloudSpeechError({ provider: "chatgpt", reason: "missing-key" });
      const env = yield* mergeProviderInstanceEnvironment(instance?.environment, baseEnv);
      const directory = expandHomePath(
        config.shadowHomePath || config.homePath || env.CODEX_HOME || path.join(home, ".codex"),
        home,
      );
      const raw = yield* fs
        .readFileString(path.join(directory, "auth.json"))
        .pipe(
          Effect.mapError(
            () => new CloudSpeechError({ provider: "chatgpt", reason: "missing-key" }),
          ),
        );
      const login = yield* decodeNativeLogin(raw).pipe(
        Effect.mapError(
          () => new CloudSpeechError({ provider: "chatgpt", reason: "unreadable-key" }),
        ),
      );
      if (login.auth_mode && login.auth_mode !== "chatgpt")
        return yield* new CloudSpeechError({ provider: "chatgpt", reason: "missing-key" });
      return {
        directory,
        token: Redacted.make(login.tokens.access_token),
        account: Redacted.make(login.tokens.account_id),
      };
    });
    const configured = credentials.pipe(
      Effect.flatMap(({ openai, xai, openrouter }) =>
        nativeLogin().pipe(
          Effect.isSuccess,
          Effect.map((chatgpt) => ({
            chatgpt,
            openai: Boolean(openai),
            xai: Boolean(xai),
            openrouter: Boolean(openrouter),
          })),
        ),
      ),
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
    const setKey = Effect.fn("CloudSpeech.setKey")(function* (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) {
      if (provider === "chatgpt") return;
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
        const login = provider === "chatgpt" ? yield* nativeLogin() : undefined;
        const source = provider === "chatgpt" ? undefined : (yield* credentials)[provider];
        if (!login && !source)
          return yield* new CloudSpeechError({ provider, reason: "missing-key" });
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
        if (source && isSecretReference(source)) yield* resolver.invalidate([source]);
        const unreadable = () => new CloudSpeechError({ provider, reason: "unreadable-key" });
        const key = login
          ? Redacted.value(login.token)
          : yield* requireSettingsSecret(resolver, source!).pipe(Effect.mapError(unreadable));
        if (!isApiKey(key)) return yield* unreadable();
        const audio = wave(samples);
        const subscriptionForm = new FormData();
        subscriptionForm.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
        if (language !== "auto") subscriptionForm.set("language", language);
        const request = HttpClientRequest.post(
          provider === "chatgpt"
            ? "https://chatgpt.com/backend-api/transcribe"
            : endpoints[provider].url,
        ).pipe(
          HttpClientRequest.bearerToken(Redacted.make(key)),
          provider === "chatgpt"
            ? HttpClientRequest.bodyFormData(subscriptionForm)
            : provider === "openrouter"
              ? openRouterBody(model!, audio, language)
              : audioBody(provider, audio, language, options),
        );
        const unavailable = () => new CloudSpeechError({ provider, reason: "unavailable" });
        // A catalog fetch or vault lookup may have outlived the credential it started with.
        if (login) {
          const current = yield* nativeLogin();
          if (
            current.directory !== login.directory ||
            Redacted.value(current.token) !== key ||
            Redacted.value(current.account) !== Redacted.value(login.account)
          )
            return yield* new CloudSpeechError({ provider, reason: "key-changed" });
        }
        const current = provider === "chatgpt" ? undefined : (yield* credentials)[provider];
        if (!login && (!current || !sameCredential(source!, current)))
          return yield* new CloudSpeechError({
            provider,
            reason: current ? "key-changed" : "missing-key",
          });
        const response = yield* execute(
          login
            ? HttpClientRequest.setHeader(
                request,
                "ChatGPT-Account-Id",
                Redacted.value(login.account),
              )
            : request,
        ).pipe(Effect.mapError(unavailable));
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
        const result =
          provider === "chatgpt"
            ? yield* response.stream.pipe(
                Stream.runFold(
                  () => new Uint8Array(),
                  (body, chunk) => {
                    if (body.byteLength + chunk.byteLength > 1024 * 1024) throw unavailable();
                    const next = new Uint8Array(body.byteLength + chunk.byteLength);
                    next.set(body);
                    next.set(chunk, body.byteLength);
                    return next;
                  },
                ),
                Effect.flatMap((body) => decodeTranscript(new TextDecoder().decode(body))),
                Effect.catchCause(() => Effect.fail(unavailable())),
              )
            : yield* HttpClientResponse.schemaBodyJson(EnvironmentSpeechTranscriptionResult)(
                response,
              ).pipe(Effect.mapError(unavailable));
        if (login) {
          const current = yield* nativeLogin();
          if (
            current.directory !== login.directory ||
            Redacted.value(current.token) !== key ||
            Redacted.value(current.account) !== Redacted.value(login.account)
          )
            return yield* new CloudSpeechError({ provider, reason: "key-changed" });
        }
        const { text } = result;
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
