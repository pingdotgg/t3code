import {
  SpeechSynthesisError,
  SpeechOutputSettings,
  type SpeechSynthesisRequest,
  type ElevenLabsVoicePage,
  type SpeechSynthesisVoices,
  SettingsSecretValue,
  isSecretReference,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Headers, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import { pcm16Wave } from "./synthesisAudio.ts";
import { readBoundedSpeechBody } from "./httpBody.ts";
import * as PiperRuntime from "./PiperRuntime.ts";
import { SPEECH_VOICES } from "./voices.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";

const PIPER_PROGRAM = `import sys, wave
from pathlib import Path
from piper import PiperVoice
voice = PiperVoice.load(sys.argv[1], download_dir=Path(sys.argv[1]).parent)
with wave.open(sys.argv[2], "wb") as output:
    voice.synthesize_wav(sys.stdin.read(), output)
`;

const OPENAI_MODEL = "gpt-4o-mini-tts";
const ELEVENLABS_MODEL = "eleven_multilingual_v2";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const sameCredential = Schema.toEquivalence(SettingsSecretValue);

const ElevenLabsVoicesResponse = Schema.Struct({
  voices: Schema.Array(
    Schema.Struct({
      voice_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      name: Schema.String.check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(1000)),
  has_more: Schema.Boolean,
  next_page_token: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
});

const decodeElevenLabsVoices = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ElevenLabsVoicesResponse),
);

export class SpeechSynthesisOperationError extends Schema.TaggedError<SpeechSynthesisOperationError>()(
  "SpeechSynthesisOperationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Speech synthesis failed.";
  }

  static fromCause(cause: unknown) {
    return new SpeechSynthesisOperationError({ cause });
  }
}

export class SpeechSynthesisService extends Context.Service<
  SpeechSynthesisService,
  {
    readonly installRuntime: Effect.Effect<
      SpeechSynthesisVoices,
      SpeechSynthesisError | SpeechSynthesisOperationError | PiperRuntime.PiperRuntimeOperationError
    >;
    readonly cancelRuntime: Effect.Effect<SpeechSynthesisVoices, SpeechSynthesisOperationError>;
    readonly removeRuntime: Effect.Effect<
      SpeechSynthesisVoices,
      SpeechSynthesisError | SpeechSynthesisOperationError | PiperRuntime.PiperRuntimeOperationError
    >;
    readonly voices: Effect.Effect<SpeechSynthesisVoices, SpeechSynthesisOperationError>;
    readonly elevenLabsVoices: (
      pageToken?: string,
    ) => Effect.Effect<ElevenLabsVoicePage, SpeechSynthesisError | SpeechSynthesisOperationError>;
    readonly downloadVoice: (
      voiceId: string,
    ) => Effect.Effect<SpeechSynthesisVoices, SpeechSynthesisError | SpeechSynthesisOperationError>;
    readonly cancelVoiceDownload: (
      voiceId: string,
    ) => Effect.Effect<SpeechSynthesisVoices, SpeechSynthesisOperationError>;
    readonly selectVoice: (
      voiceId: string,
    ) => Effect.Effect<SpeechSynthesisVoices, SpeechSynthesisError | SpeechSynthesisOperationError>;
    readonly removeVoice: (
      voiceId: string,
    ) => Effect.Effect<SpeechSynthesisVoices, SpeechSynthesisError | SpeechSynthesisOperationError>;
    readonly synthesize: (
      input: SpeechSynthesisRequest,
    ) => Effect.Effect<Uint8Array, SpeechSynthesisError | SpeechSynthesisOperationError>;
  }
>()("t3/speech/SpeechSynthesisService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const process = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const resolver = yield* SecretResolver.SecretResolver;
  const synthesis = yield* Semaphore.make(1);
  const store = yield* SpeechModelStore.SpeechModelStore;
  const runtime = yield* PiperRuntime.PiperRuntime;
  const scope = yield* Effect.scope;
  let downloading:
    | {
        voiceId: string;
        downloaded: number;
        verifying: boolean;
        fiber: Deferred.Deferred<Fiber.Fiber<void, SpeechSynthesisOperationError>>;
      }
    | undefined;

  const definition = Effect.fn("SpeechSynthesisService.voice")(function* (voiceId: string) {
    const voice = SPEECH_VOICES.find((voice) => voice.id === voiceId);
    if (!voice) return yield* new SpeechSynthesisError({ reason: "voice-not-found" });
    return voice;
  });
  const installedVoicePath = Effect.fn("SpeechSynthesisService.installedVoicePath")(function* (
    voiceId: string,
  ) {
    const voice = yield* definition(voiceId);
    const paths = yield* Effect.forEach(voice.files, (file) => store.installedPath(file));
    if (paths.some((path) => path === undefined))
      return yield* new SpeechSynthesisError({ reason: "voice-not-installed" });
    return paths[voice.files.findIndex((file) => file.filename.endsWith(".onnx"))]!;
  });
  const voices = Effect.gen(function* () {
    const snapshot = yield* settings.getSettings.pipe(
      Effect.mapError(SpeechSynthesisOperationError.fromCause),
    );
    const runtimeStatus = yield* runtime.status;
    return {
      runtime: runtimeStatus,
      providers: [
        {
          id: "piper" as const,
          name: "Piper",
          configured: runtimeStatus.state === "ready",
          defaultVoice: snapshot.speechOutput.piperVoiceId,
          voices: [],
        },
        {
          id: "openai" as const,
          name: "OpenAI",
          configured: Boolean(snapshot.cloudSpeechCredentials.openai),
          defaultVoice: snapshot.speechOutput.voice,
          voices: SpeechOutputSettings.fields.voice.literals.map((id) => ({ id, name: id })),
          model: OPENAI_MODEL,
        },
        {
          id: "elevenlabs" as const,
          name: "ElevenLabs",
          configured: Boolean(snapshot.speechOutput.elevenLabsApiKey),
          defaultVoice: snapshot.speechOutput.elevenLabsVoiceId,
          voices: [],
          model: ELEVENLABS_MODEL,
        },
      ],
      voices: yield* Effect.forEach(
        SPEECH_VOICES,
        (voice) =>
          Effect.gen(function* () {
            const ready = (yield* Effect.forEach(voice.files, (file) => store.isReady(file))).every(
              Boolean,
            );
            const transfer = downloading?.voiceId === voice.id ? downloading : undefined;
            return {
              id: voice.id,
              name: voice.name,
              language: voice.language,
              languageName: voice.languageName,
              quality: voice.quality,
              size: voice.size,
              modelCardUrl: voice.modelCardUrl,
              active: snapshot.speechOutput.piperVoiceId === voice.id,
              state: transfer
                ? transfer.verifying
                  ? ("verifying" as const)
                  : ("downloading" as const)
                : ready
                  ? ("installed" as const)
                  : ("downloadable" as const),
              ...(transfer ? { downloaded: transfer.downloaded } : {}),
            };
          }),
        { concurrency: 8 },
      ),
    };
  }).pipe(Effect.withSpan("SpeechSynthesisService.voices"));

  const downloadFiber = Effect.fn("SpeechSynthesisService.downloadFiber")(
    function* (voiceId: string) {
      const voice = yield* definition(voiceId);
      if (downloading?.voiceId === voiceId) return yield* Deferred.await(downloading.fiber);
      if (downloading) return yield* new SpeechSynthesisError({ reason: "busy" });
      const transfer = {
        voiceId,
        downloaded: 0,
        verifying: false,
        fiber: Deferred.makeUnsafe<Fiber.Fiber<void, SpeechSynthesisOperationError>>(),
      };
      downloading = transfer;
      const acquired = new Set<string>();
      const fiber = yield* Effect.gen(function* () {
        let completed = 0;
        for (const file of voice.files) {
          if (!(yield* store.isReady(file))) acquired.add(file.filename);
          yield* store
            .download(file, {
              onProgress: (downloaded) => {
                transfer.downloaded = completed + downloaded;
                transfer.verifying = false;
              },
              onVerificationStart: () => {
                transfer.verifying = true;
              },
            })
            .pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
          completed += file.size;
          transfer.downloaded = completed;
        }
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.forEach(
                voice.files.filter((file) => acquired.has(file.filename)),
                (file) => store.remove(file).pipe(Effect.ignore),
              ),
        ),
        Effect.forkIn(scope),
      );
      fiber.addObserver(() => {
        if (downloading === transfer) downloading = undefined;
      });
      yield* Deferred.succeed(transfer.fiber, fiber);
      return fiber;
    },
    Effect.uninterruptible,
    synthesis.withPermits(1),
  );
  const downloadVoice = Effect.fn("SpeechSynthesisService.downloadVoice")(function* (
    voiceId: string,
  ) {
    const exit = yield* Fiber.await(yield* downloadFiber(voiceId));
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
      return yield* Effect.failCause(exit.cause);
    return yield* voices;
  });
  const cancelVoiceDownload = Effect.fn("SpeechSynthesisService.cancelVoiceDownload")(function* (
    voiceId: string,
  ) {
    if (downloading?.voiceId === voiceId)
      yield* Fiber.interrupt(yield* Deferred.await(downloading.fiber));
    return yield* voices;
  });
  const selectVoice = Effect.fn("SpeechSynthesisService.selectVoice")(function* (voiceId: string) {
    if (downloading?.voiceId === voiceId)
      return yield* new SpeechSynthesisError({ reason: "busy" });
    yield* installedVoicePath(voiceId);
    yield* settings
      .updateSettings({ speechOutput: { piperVoiceId: voiceId } })
      .pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
    return yield* voices;
  }, synthesis.withPermits(1));
  const removeVoice = Effect.fn("SpeechSynthesisService.removeVoice")(function* (voiceId: string) {
    const voice = yield* definition(voiceId);
    if (downloading?.voiceId === voiceId)
      return yield* new SpeechSynthesisError({ reason: "busy" });
    for (const file of voice.files)
      yield* store.remove(file).pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
    const snapshot = yield* settings.getSettings.pipe(
      Effect.mapError(SpeechSynthesisOperationError.fromCause),
    );
    if (snapshot.speechOutput.piperVoiceId === voiceId)
      yield* settings
        .updateSettings({ speechOutput: { piperVoiceId: "" } })
        .pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
    return yield* voices;
  }, synthesis.withPermits(1));

  const cloudKey = Effect.fn("SpeechSynthesisService.cloudKey")(function* (
    engine: "openai" | "elevenlabs",
    source: SettingsSecretValue,
  ) {
    if (!source) return yield* new SpeechSynthesisError({ reason: "not-configured" });
    if (isSecretReference(source)) yield* resolver.invalidate([source]);
    const key = yield* requireSettingsSecret(resolver, source).pipe(
      Effect.mapError(SpeechSynthesisOperationError.fromCause),
    );
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(SpeechSynthesisOperationError.fromCause),
    );
    if (
      !sameCredential(
        engine === "elevenlabs"
          ? current.speechOutput.elevenLabsApiKey
          : current.cloudSpeechCredentials.openai,
        source,
      )
    )
      return yield* new SpeechSynthesisError({ reason: "configuration-changed" });
    return key;
  });
  const executeCloudRequest = Effect.fn("SpeechSynthesisService.executeCloudRequest")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.updateService(Headers.CurrentRedactedNames, (names) => [...names, "xi-api-key"]),
      Effect.mapError(() => new SpeechSynthesisError({ reason: "unavailable" })),
    );
    if (response.status === 401 || response.status === 403)
      return yield* new SpeechSynthesisError({ reason: "rejected-key" });
    if (response.status === 429) return yield* new SpeechSynthesisError({ reason: "rate-limit" });
    if (response.status !== 200) return yield* new SpeechSynthesisError({ reason: "unavailable" });
    return response;
  });
  const elevenLabsVoices = Effect.fn("SpeechSynthesisService.elevenLabsVoices")(
    function* (pageToken?: string) {
      const snapshot = yield* settings.getSettings.pipe(
        Effect.mapError(SpeechSynthesisOperationError.fromCause),
      );
      const key = yield* cloudKey("elevenlabs", snapshot.speechOutput.elevenLabsApiKey);
      const response = yield* executeCloudRequest(
        HttpClientRequest.get("https://api.elevenlabs.io/v2/voices").pipe(
          HttpClientRequest.setHeader("xi-api-key", key),
          HttpClientRequest.setUrlParams({
            page_size: "100",
            ...(pageToken ? { next_page_token: pageToken } : {}),
          }),
        ),
      );
      const bytes = yield* readBoundedSpeechBody(response, 1024 * 1024).pipe(
        Effect.mapError(() => new SpeechSynthesisError({ reason: "unavailable" })),
      );
      const data = yield* decodeElevenLabsVoices(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError(() => new SpeechSynthesisError({ reason: "unavailable" })),
      );
      if (data.has_more && (!data.next_page_token || data.next_page_token === pageToken))
        return yield* new SpeechSynthesisError({ reason: "unavailable" });
      return {
        voices: data.voices.map((voice) => ({
          id: voice.voice_id,
          name: voice.name.trim() || voice.voice_id,
        })),
        ...(data.has_more && data.next_page_token ? { nextPageToken: data.next_page_token } : {}),
      };
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new SpeechSynthesisError({ reason: "unavailable" })),
    }),
  );

  const synthesize = Effect.fn("SpeechSynthesisService.synthesize")(
    function* (input: SpeechSynthesisRequest) {
      const text = input.text.trim();
      if (!text || text.length > 2000)
        return yield* new SpeechSynthesisError({ reason: "invalid-text" });
      const snapshot = yield* settings.getSettings.pipe(
        Effect.mapError(SpeechSynthesisOperationError.fromCause),
      );
      const config = snapshot.speechOutput;
      if (
        input.engine === "openai" &&
        input.voice &&
        !SpeechOutputSettings.fields.voice.literals.some((voice) => voice === input.voice)
      )
        return yield* new SpeechSynthesisError({ reason: "voice-not-found" });
      if (
        input.engine === "elevenlabs" &&
        input.voice &&
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.voice)
      )
        return yield* new SpeechSynthesisError({ reason: "voice-not-found" });
      let audio: Uint8Array;
      if (input.engine === "piper") {
        if (!(input.voice ?? config.piperVoiceId))
          return yield* new SpeechSynthesisError({ reason: "not-configured" });
        const modelPath = yield* installedVoicePath(input.voice ?? config.piperVoiceId);
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-tts-" })
          .pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
        const output = path.join(directory, "speech.wav");
        const result = yield* process
          .run({
            command: yield* runtime.executable,
            args: ["-I", "-X", "utf8", "-c", PIPER_PROGRAM, modelPath, output],
            stdin: `${text}\n`,
            timeout: "2 minutes",
            maxOutputBytes: 64 * 1024,
          })
          .pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
        if (result.code !== 0) return yield* new SpeechSynthesisError({ reason: "unavailable" });
        const info = yield* fs
          .stat(output)
          .pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
        if (Number(info.size) > MAX_AUDIO_BYTES)
          return yield* new SpeechSynthesisError({ reason: "invalid-audio" });
        audio = yield* fs
          .readFile(output)
          .pipe(Effect.mapError(SpeechSynthesisOperationError.fromCause));
      } else {
        const elevenLabs = input.engine === "elevenlabs";
        const source = elevenLabs
          ? config.elevenLabsApiKey
          : snapshot.cloudSpeechCredentials.openai;
        const key = yield* cloudKey(input.engine, source);
        const request = elevenLabs
          ? HttpClientRequest.post(
              `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voice ?? config.elevenLabsVoiceId)}?output_format=pcm_24000`,
            ).pipe(
              HttpClientRequest.setHeader("xi-api-key", key),
              HttpClientRequest.setHeader("content-type", "application/json"),
              HttpClientRequest.bodyJsonUnsafe({ text, model_id: ELEVENLABS_MODEL }),
            )
          : HttpClientRequest.post("https://api.openai.com/v1/audio/speech").pipe(
              HttpClientRequest.bearerToken(Redacted.make(key)),
              HttpClientRequest.setHeader("content-type", "application/json"),
              HttpClientRequest.bodyJsonUnsafe({
                model: OPENAI_MODEL,
                input: text,
                voice: input.voice ?? config.voice,
                response_format: "wav",
              }),
            );
        const response = yield* executeCloudRequest(request);
        audio = yield* readBoundedSpeechBody(response, MAX_AUDIO_BYTES).pipe(
          Effect.mapError(
            (error) =>
              new SpeechSynthesisError({
                reason: error._tag === "SpeechBodyTooLarge" ? "invalid-audio" : "unavailable",
              }),
          ),
        );
        if (elevenLabs) {
          if (
            audio.length === 0 ||
            audio.length % 2 !== 0 ||
            audio.length > MAX_AUDIO_BYTES - 44 ||
            /json|^text\//i.test(response.headers["content-type"] ?? "")
          )
            return yield* new SpeechSynthesisError({ reason: "invalid-audio" });
          audio = pcm16Wave(audio, 24000);
        }
      }
      if (
        audio.length < 44 ||
        audio.length > MAX_AUDIO_BYTES ||
        new TextDecoder().decode(audio.subarray(0, 4)) !== "RIFF" ||
        new TextDecoder().decode(audio.subarray(8, 12)) !== "WAVE"
      )
        return yield* new SpeechSynthesisError({ reason: "invalid-audio" });
      return audio;
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () => Effect.fail(new SpeechSynthesisError({ reason: "unavailable" })),
    }),
    synthesis.withPermits(1),
  );
  return SpeechSynthesisService.of({
    installRuntime: runtime.install.pipe(Effect.andThen(voices)),
    cancelRuntime: runtime.cancel.pipe(Effect.andThen(voices)),
    removeRuntime: runtime.remove.pipe(Effect.andThen(voices), synthesis.withPermits(1)),
    synthesize,
    voices,
    elevenLabsVoices,
    downloadVoice,
    cancelVoiceDownload,
    selectVoice,
    removeVoice,
  });
});

export const layer = Layer.effect(SpeechSynthesisService, make);
