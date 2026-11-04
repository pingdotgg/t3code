import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechService from "./SpeechService.ts";

const native = vi.hoisted(() => ({
  backend: "Vulkan0",
  supportsStreaming: true,
  supportsTranslation: true,
  supportsInitialPrompt: false,
  begin: vi.fn(async (_language?: string, _words?: readonly string[], _dictionary?: unknown) => {}),
  feed: vi.fn(async (_pcm: Float32Array) => ({
    revision: 1,
    text: { committed: "", tentative: "hello" },
  })),
  finish: vi.fn(async () => "hello"),
  reset: vi.fn(async () => {}),
  dispose: vi.fn(),
  transcribe: vi.fn(async (_pcm: Float32Array, _options?: unknown) => ({ text: "hello" })),
}));
const loadNative = vi.hoisted(() =>
  vi.fn(
    async (
      _path: string,
      _signal: AbortSignal,
      _moduleUrl?: string,
      backend: "auto" | "cpu" = "auto",
    ) => {
      native.backend = backend === "cpu" ? "CPU" : "Vulkan0";
      return native;
    },
  ),
);
const readyModels = vi.hoisted(() => new Set(["test-model", "fallback-model"]));
const modelDefinitions = vi.hoisted(() => [
  {
    id: "test-model",
    name: "test",
    description: "test",
    size: 4,
    languages: ["en", "fr"],
    accuracy: 1,
    speed: 1,
    recommended: true,
    supportsStreaming: true,
    supportsLanguageDetection: false,
    supportsTranslation: true,
  },
  {
    id: "fallback-model",
    name: "fallback",
    description: "fallback",
    size: 8,
    languages: ["en"],
    accuracy: 2,
    speed: 2,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: false,
  },
]);
vi.mock("./native.ts", () => ({
  loadNativeSpeechModel: loadNative,
  listNativeSpeechGpuDevices: vi.fn(async () => [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }]),
}));
vi.mock("./model.ts", () => ({
  DEFAULT_SPEECH_MODEL_ID: "test-model",
  SPEECH_MODELS: modelDefinitions,
  getSpeechModel: (modelId: string) => modelDefinitions.find((model) => model.id === modelId),
  effectiveSpeechLanguage: (model: { languages: string[] }, intent: string) =>
    intent !== "auto" && model.languages.includes(intent) ? intent : "en",
}));
const download = vi.fn<SpeechModelStore.SpeechModelStore["Service"]["download"]>(() =>
  Effect.succeed("test.gguf"),
);
const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: (model) => Effect.sync(() => readyModels.has(model.id)),
    installedPath: (model) =>
      Effect.sync(() => (readyModels.has(model.id) ? "test.gguf" : undefined)),
    download,
    remove: (model) =>
      Effect.sync(() => {
        readyModels.delete(model.id);
      }),
  }),
);
const layer = SpeechService.layer.pipe(
  Layer.provide(store),
  Layer.provideMerge(ServerSettings.layerTest({ speechModelId: "test-model" })),
  Layer.provide(NodeServices.layer),
);
const pcm = () => new Uint8Array(new Float32Array([0.25]).buffer);

beforeEach(() => {
  vi.clearAllMocks();
  native.backend = "Vulkan0";
  native.supportsInitialPrompt = false;
  readyModels.clear();
  readyModels.add("test-model");
  readyModels.add("fallback-model");
});

it("decodes a pooled Node Buffer without reading adjacent bytes", () => {
  const pool = Buffer.allocUnsafe(64);
  pool.fill(0xff);
  Buffer.from(new Float32Array([0.25]).buffer).copy(pool, 20);
  expect([...SpeechService.decodeSpeechPcm(pool.subarray(20, 24))]).toEqual([0.25]);
});

it("rejects empty, misaligned, non-finite, and oversized PCM as invalid audio", () => {
  for (const input of [
    new Uint8Array(),
    new Uint8Array(3),
    new Uint8Array(new Float32Array([Number.NaN]).buffer),
    new Uint8Array(SpeechService.MAX_SPEECH_BYTES + 4),
  ]) {
    expect(() => SpeechService.decodeSpeechPcm(input)).toThrow(
      expect.objectContaining({ _tag: "SpeechInvalidAudioError" }),
    );
  }
});

it.effect("prepares a batch model before audio arrives and reuses it for transcription", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.selectModel("fallback-model");
    yield* speech.prepareModel;
    expect(loadNative).toHaveBeenCalledTimes(1);
    expect(native.transcribe).not.toHaveBeenCalled();
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    expect(loadNative).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a detached download exclusive until the transfer finishes", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    download.mockImplementationOnce(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
        Effect.as("test.gguf"),
      ),
    );
    const request = yield* speech.downloadModel("test-model").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(request);
    const removed = yield* Effect.result(speech.removeModel("test-model"));
    expect(Result.isFailure(removed) && removed.failure).toMatchObject({ _tag: "SpeechBusyError" });
    const join = yield* speech
      .downloadModel("test-model")
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(join);
    expect(download).toHaveBeenCalledTimes(1);
    yield* speech.removeModel("test-model");
    expect(readyModels.has("test-model")).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("honors an exact alias before a similar preferred term in batch and streamed text", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const options = {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechCustomWords: [
        { term: "Bob", aliases: ["Robert"] },
        { term: "Roberts", aliases: [] },
      ],
    };
    native.transcribe.mockResolvedValueOnce({ text: "Robert, Roberts." });
    native.finish.mockResolvedValueOnce("Robert, Roberts.");
    expect(yield* speech.transcribe(pcm(), options)).toBe("Bob, Roberts.");
    const stream = yield* speech.startStream(options);
    expect(yield* stream.finish).toBe("Bob, Roberts.");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("unloads after the chosen idle period and reloads on the next recording", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("min_2");
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    yield* TestClock.adjust(2 * 60_000 - 1);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* TestClock.adjust(1);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("holds model ownership until the stream scope closes and preserves silence", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      const busy = yield* Effect.result(speech.selectModel("fallback-model"));
      expect(Result.isFailure(busy) && busy.failure).toMatchObject({ _tag: "SpeechBusyError" });
      yield* stream.feed(new Uint8Array(new Float32Array(160).buffer));
      expect(native.feed.mock.calls[0]?.[0]).toHaveLength(160);
      expect(yield* stream.finish).toBe("hello");
    }).pipe(Effect.scoped);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.selectModel("fallback-model");
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("resets cancelled streams and reuses the loaded model", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      yield* stream.feed(pcm());
      yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("closes its scope without waiting for hung native inference", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    native.transcribe.mockImplementationOnce(() => {
      started.resolve();
      return new Promise(() => {});
    });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const request = yield* speech
        .transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
    }).pipe(Effect.provide(layer));
    expect(native.dispose).toHaveBeenCalledOnce();
  }),
);

it.effect("reports unsupported hosts without wrapping a synthetic cause", () =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS));
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Architecture, "arm64"),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechUnsupportedPlatformError",
      platform: "win32",
      architecture: "arm64",
    });
  }),
);

it.effect("retries Auto-placed inference on this host's CPU after the native process fails", () =>
  Effect.gen(function* () {
    native.transcribe.mockRejectedValueOnce(new Error("worker stopped"));
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    expect(loadNative).toHaveBeenCalledTimes(2);
    expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
  }).pipe(Effect.provide(layer)),
);

it.effect("reports a failure on a GPU the person chose instead of switching to CPU", () =>
  Effect.gen(function* () {
    const failure = new Error("GPU failed");
    native.transcribe.mockRejectedValueOnce(failure);
    const speech = yield* SpeechService.SpeechService;
    const acceleration = 'gpu:["vulkan","gpu-1"]';
    yield* speech.updateAcceleration(acceleration);
    const result = yield* Effect.result(
      speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechOperationError",
      operation: "inference",
      cause: failure,
    });
    expect(loadNative).toHaveBeenCalledTimes(1);
    expect(loadNative.mock.calls[0]?.[3]).toBe(acceleration);
  }).pipe(Effect.provide(layer)),
);

it.effect("replays streamed audio on CPU after an Auto-placed feed crashes, once", () =>
  Effect.gen(function* () {
    const text = { committed: "", tentative: "hello" };
    native.feed
      .mockResolvedValueOnce({ revision: 3, text })
      .mockRejectedValueOnce(new Error("worker stopped"))
      .mockResolvedValueOnce({ revision: 1, text })
      .mockResolvedValueOnce({ revision: 2, text })
      .mockResolvedValueOnce({ revision: 3, text })
      .mockRejectedValueOnce(new Error("worker stopped again"));
    const speech = yield* SpeechService.SpeechService;
    const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    expect(yield* stream.feed(pcm())).toEqual({ revision: 3, text });
    expect(yield* stream.feed(pcm())).toEqual({ revision: 5, text });
    expect(loadNative).toHaveBeenCalledTimes(2);
    expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
    expect(native.begin).toHaveBeenCalledTimes(2);
    expect(native.feed).toHaveBeenCalledTimes(4);
    expect(yield* stream.feed(pcm())).toEqual({ revision: 6, text });
    expect(Result.isFailure(yield* Effect.result(stream.feed(pcm())))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
