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
  type SpeechStreamText,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { applySpeechAliases, speechRecognitionWords } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import { decodeSpeechPcm, MAX_SPEECH_BYTES, SpeechInvalidAudioError } from "./SpeechService.ts";

const endpoints = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe" },
  xai: { url: "https://api.x.ai/v1/stt", model: "grok-voice-transcribe-2.0" },
  openrouter: { url: "https://openrouter.ai/api/v1/audio/transcriptions" },
};
const XAI_STREAM_URL = "wss://api.x.ai/v1/stt";
const XAI_AUDIO_DONE = '{"type":"audio.done"}';
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
  writePcm16(view, 44, samples);
  return buffer;
}

function finalizeTranscript(text: string, language: string, options: SpeechTranscriptionOptions) {
  const corrected = applySpeechAliases(text, options.speechCustomWords);
  return (
    options.speechRemoveFillerWords
      ? removeSpeechFillerWords(corrected, language, options.speechCorrectionWord)
      : corrected
  ).trim();
}

function writePcm16(view: DataView, offset: number, samples: Float32Array) {
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    view.setInt16(offset + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
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
  for (const term of speechRecognitionWords(
    options.speechHints,
    options.speechCustomWords.map(({ term }) => term),
  )) {
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

/** xAI takes streaming options in the query and starts transcribing without a setup message. */
function xaiStreamUrl(language: string, options: SpeechTranscriptionOptions) {
  const url = new URL(XAI_STREAM_URL);
  const query = url.searchParams;
  query.set("model", endpoints.xai.model);
  query.set("sample_rate", "16000");
  query.set("encoding", "pcm");
  query.set("interim_results", "true");
  if (language !== "auto") {
    query.set("language", language);
    query.set("format", "true");
  }
  for (const term of speechRecognitionWords(
    options.speechHints,
    options.speechCustomWords.map(({ term }) => term),
  ))
    query.append("keyterm", term);
  query.set(
    "filler_words",
    String(!options.speechRemoveFillerWords || Boolean(options.speechCorrectionWord)),
  );
  if (!options.speechSilenceFiltering) query.set("vad_threshold", "0");
  return url.toString();
}

const decodeXaiStreamEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("transcript.created") }),
      Schema.Struct({
        type: Schema.Literal("transcript.partial"),
        text: Schema.String,
        is_final: Schema.optionalKey(Schema.Boolean),
        speech_final: Schema.optionalKey(Schema.Boolean),
      }),
      Schema.Struct({ type: Schema.Literal("transcript.done") }),
      Schema.Struct({ type: Schema.Literal("error") }),
    ]),
  ),
);

export type CloudSpeechStream = {
  readonly feed: (
    pcm: Uint8Array,
  ) => Effect.Effect<
    { readonly revision: number; readonly text: SpeechStreamText | null },
    CloudSpeechError | SpeechInvalidAudioError
  >;
  readonly finish: Effect.Effect<string, CloudSpeechError>;
};

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
    /** Live transcription; xAI is the only provider with a streaming endpoint. */
    readonly startStream: (
      provider: "xai",
      options: SpeechTranscriptionOptions,
    ) => Effect.Effect<CloudSpeechStream, CloudSpeechError | ServerSettingsError, Scope.Scope>;
  }
>()("t3/speech/CloudSpeech") {}

export const layer = Layer.effect(
  CloudSpeech,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const http = yield* HttpClient.HttpClient;
    const webSocket = yield* Socket.WebSocketConstructor;
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
    const unlockKey = Effect.fn("CloudSpeech.unlockKey")(function* (
      provider: CloudSpeechProvider,
      source: SettingsSecretValue,
    ) {
      // A vault that locked since the last recording must not authorize a new upload.
      if (isSecretReference(source)) yield* resolver.invalidate([source]);
      const unreadable = () => new CloudSpeechError({ provider, reason: "unreadable-key" });
      const key = yield* requireSettingsSecret(resolver, source).pipe(Effect.mapError(unreadable));
      if (!isApiKey(key)) return yield* unreadable();
      return key;
    });
    const requireCurrentKey = Effect.fn("CloudSpeech.requireCurrentKey")(function* (
      provider: CloudSpeechProvider,
      source: SettingsSecretValue,
    ) {
      const current = (yield* credentials)[provider];
      if (!current || !sameCredential(source, current))
        return yield* new CloudSpeechError({
          provider,
          reason: current ? "key-changed" : "missing-key",
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
        const key = yield* unlockKey(provider, source);
        const audio = wave(samples);
        const request = HttpClientRequest.post(endpoints[provider].url).pipe(
          HttpClientRequest.bearerToken(Redacted.make(key)),
          provider === "openrouter"
            ? openRouterBody(model!, audio, language)
            : audioBody(provider, audio, language, options),
        );
        const unavailable = () => new CloudSpeechError({ provider, reason: "unavailable" });
        // A catalog fetch or vault lookup may have outlived the credential it started with.
        yield* requireCurrentKey(provider, source);
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
        return finalizeTranscript(text, language, options);
      },
      (effect, provider) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () => Effect.fail(new CloudSpeechError({ provider, reason: "unavailable" })),
          }),
        ),
    );
    const startStream = Effect.fn("CloudSpeech.startStream")(function* (
      provider: "xai",
      options: SpeechTranscriptionOptions,
    ) {
      const source = (yield* credentials)[provider];
      if (!source) return yield* new CloudSpeechError({ provider, reason: "missing-key" });
      const language = effectiveSpeechLanguage(cloudSpeechLanguages, options.speechLanguage);
      const key = yield* unlockKey(provider, source);
      yield* requireCurrentKey(provider, source);
      const unavailable = () => new CloudSpeechError({ provider, reason: "unavailable" });
      const created = Promise.withResolvers<void>();
      const done = Promise.withResolvers<string>();
      void created.promise.catch(() => undefined);
      void done.promise.catch(() => undefined);
      let failure: CloudSpeechError | undefined;
      const fail = (error: CloudSpeechError) => {
        failure ??= error;
        created.reject(failure);
        done.reject(failure);
      };
      // Finished utterances and ~3 s chunks are locked; the interim result may still change.
      const locked: string[] = [];
      let chunks: string[] = [];
      let interim = "";
      let revision = 0;
      const lockedText = () => [...locked, ...chunks].join(" ");
      // Listeners attach before the fiber yields, so no early event is missed.
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = webSocket(xaiStreamUrl(language, options), {
            headers: { authorization: `Bearer ${key}` },
          });
          socket.addEventListener("message", ({ data }) => {
            // xAI sends every event as JSON text.
            if (typeof data !== "string") return;
            const event = decodeXaiStreamEvent(data);
            if (Option.isNone(event)) return;
            switch (event.value.type) {
              case "transcript.created":
                return created.resolve();
              case "transcript.partial": {
                const text = event.value.text.trim();
                if (event.value.speech_final) {
                  // The utterance-final result restates the chunks it locked earlier.
                  if (text) locked.push(text);
                  chunks = [];
                  interim = "";
                } else if (event.value.is_final) {
                  if (text) chunks.push(text);
                  interim = "";
                } else interim = text;
                revision++;
                return;
              }
              // The done event's own text is empty; the transcript is what was locked.
              case "transcript.done":
                return done.resolve([lockedText(), interim].join(" "));
              case "error":
                return fail(unavailable());
            }
          });
          // A refused upgrade, such as a rejected key, reaches here without its HTTP status.
          socket.addEventListener("error", () => fail(unavailable()));
          socket.addEventListener("close", () => fail(unavailable()));
          return socket;
        }),
        (socket) => Effect.sync(() => socket.close()),
      );
      // xAI drops audio that arrives before the session exists.
      yield* Effect.tryPromise({
        try: () => created.promise,
        catch: () => failure ?? unavailable(),
      }).pipe(
        Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(unavailable()) }),
      );
      let byteLength = 0;
      // Frames between xAI results only acknowledge audio; the client keeps the last text.
      let shownRevision = 0;
      return {
        // Runs for every ~100 ms audio frame, so it adds no span of its own.
        feed: Effect.fnUntraced(function* (bytes: Uint8Array) {
          if (failure) return yield* failure;
          if (byteLength + bytes.byteLength > MAX_SPEECH_BYTES)
            return yield* new SpeechInvalidAudioError({
              byteLength: bytes.byteLength,
              message: "Speech stream audio limit exceeded.",
            });
          const samples = yield* Effect.try({
            try: () => decodeSpeechPcm(bytes),
            catch: () =>
              new SpeechInvalidAudioError({
                byteLength: bytes.byteLength,
                message: "Invalid PCM audio.",
              }),
          });
          byteLength += bytes.byteLength;
          const pcm = new Uint8Array(samples.length * 2);
          writePcm16(new DataView(pcm.buffer), 0, samples);
          yield* Effect.try({
            try: () => socket.send(pcm),
            catch: () => failure ?? unavailable(),
          });
          if (revision === shownRevision) return { revision, text: null };
          shownRevision = revision;
          const committed = applySpeechAliases(lockedText(), options.speechCustomWords);
          const tentative = applySpeechAliases(interim, options.speechCustomWords);
          return {
            revision,
            text: {
              committed,
              tentative: committed && tentative ? ` ${tentative}` : tentative,
            },
          };
        }),
        finish: Effect.gen(function* () {
          if (failure) return yield* failure;
          yield* Effect.try({
            try: () => socket.send(XAI_AUDIO_DONE),
            catch: () => failure ?? unavailable(),
          });
          const text = yield* Effect.tryPromise({
            try: () => done.promise,
            catch: () => failure ?? unavailable(),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => Effect.fail(unavailable()),
            }),
          );
          return finalizeTranscript(text, language, options);
        }),
      } satisfies CloudSpeechStream;
    });
    return CloudSpeech.of({ configured, models, setKey, transcribe, startStream });
  }),
);
