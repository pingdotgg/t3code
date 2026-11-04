import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechService from "./SpeechService.ts";

const native = vi.hoisted(() => ({
  backend: "Vulkan0",
  supportsStreaming: true,
  supportsTranslation: true,
  supportsVocabulary: false,
  begin: vi.fn(async (_language?: string, _vocabulary?: readonly string[]) => {}),
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
  loadNative.mockReset();
  native.backend = "Vulkan0";
  native.supportsVocabulary = false;
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

it.effect("rejects model mutations outside the offered registry", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    for (const id of [
      "handy-computer/canary-1b-gguf",
      "handy-computer/granite-speech-5.0-470m-turboctc-nc-gguf",
      "unknown-model",
    ]) {
      for (const mutation of [speech.downloadModel, speech.selectModel, speech.removeModel]) {
        const result = yield* Effect.result(mutation(id));
        expect(Result.isFailure(result) && result.failure).toMatchObject({
          _tag: "SpeechModelNotFoundError",
          modelId: id,
        });
      }
    }
    expect(download).not.toHaveBeenCalled();
    expect((yield* speech.models).models.find((model) => model.active)?.id).toBe("test-model");
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

it.effect("honors exact aliases and phrase boundaries in batch and streamed text", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const options = {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechCustomWords: [
        { term: "AI", aliases: ["ay eye"] },
        { term: "Bob", aliases: ["Robert"] },
        { term: "Roberts", aliases: [] },
        { term: "O'Reilly", aliases: ['"the publisher"'] },
        { term: "GitHub", aliases: [] },
        { term: "McDonald’s", aliases: [] },
        { term: "King’s Cross", aliases: [] },
      ],
    };
    const spoken =
      'a test with a i and ay eye. Robert, Roberts. "the publisher" and the publisher. (git hub), git (hub). ' +
      "git hub's API, git hub’s API, git’s hub, mac donald's menu, king's cross.";
    const expected =
      "a test with AI and AI. Bob, Roberts. O'Reilly and the publisher. (GitHub), git (hub). " +
      "GitHub's API, GitHub’s API, git’s hub, McDonald’s menu, King’s Cross.";
    native.transcribe.mockResolvedValueOnce({ text: spoken });
    native.finish.mockResolvedValueOnce(spoken);
    expect(yield* speech.transcribe(pcm(), options)).toBe(expected);
    const stream = yield* speech.startStream(options);
    expect(yield* stream.finish).toBe(expected);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("uses vocabulary only for supported transcription and always applies aliases", () =>
  Effect.gen(function* () {
    for (const supportsVocabulary of [false, true]) {
      for (const translate of [false, true]) {
        yield* Effect.gen(function* () {
          native.supportsVocabulary = supportsVocabulary;
          const speech = yield* SpeechService.SpeechService;
          const options = {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            speechLanguage: "fr" as const,
            speechTranslateToEnglish: translate,
            speechCustomWords: [
              { term: "GitHub", aliases: [] },
              { term: "Bob", aliases: ["Robert"] },
              { term: "T3 Code", aliases: [] },
            ],
          };
          const vocabulary =
            supportsVocabulary && !translate ? ["GitHub", "Bob", "T3 Code"] : undefined;
          native.transcribe.mockResolvedValueOnce({ text: "git hub and Robert" });
          expect(yield* speech.transcribe(pcm(), options)).toBe(
            vocabulary ? "git hub and Bob" : "GitHub and Bob",
          );
          const delivered = native.transcribe.mock.lastCall?.[1];
          expect(delivered).toEqual({
            timestamps: "none",
            language: "fr",
            ...(translate ? { task: "translate", targetLanguage: "en" } : {}),
            ...(vocabulary ? { vocabulary } : {}),
          });
          if (translate) return;
          native.feed.mockResolvedValueOnce({
            revision: 1,
            text: { committed: "git hub", tentative: "Robert" },
          });
          native.finish.mockResolvedValueOnce("git hub and Robert");
          const stream = yield* speech.startStream(options);
          expect(yield* stream.feed(pcm())).toEqual({
            revision: 1,
            text: { committed: vocabulary ? "git hub" : "GitHub", tentative: "Bob" },
          });
          expect(yield* stream.finish).toBe(vocabulary ? "git hub and Bob" : "GitHub and Bob");
          expect(native.begin.mock.lastCall).toEqual(["fr", vocabulary]);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }
    }
  }),
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

it.effect(
  "retries Auto-placed inference with the dictionary and the CPU's vocabulary capability",
  () =>
    Effect.gen(function* () {
      for (const cpuSupportsVocabulary of [true, false]) {
        yield* Effect.gen(function* () {
          native.supportsVocabulary = true;
          loadNative.mockImplementationOnce(async () => native);
          loadNative.mockImplementationOnce(async () => ({
            ...native,
            backend: "CPU",
            supportsVocabulary: cpuSupportsVocabulary,
          }));
          native.transcribe
            .mockRejectedValueOnce(new Error("worker stopped"))
            .mockResolvedValueOnce({ text: "git hub Robert" });
          const options = {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            speechCustomWords: [
              { term: "GitHub", aliases: [] },
              { term: "Bob", aliases: ["Robert"] },
            ],
          };
          const speech = yield* SpeechService.SpeechService;
          expect(yield* speech.transcribe(pcm(), options)).toBe(
            cpuSupportsVocabulary ? "git hub Bob" : "GitHub Bob",
          );
          expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe(
            "hello",
          );
          expect(loadNative.mock.calls.slice(-2).map((call) => call[3])).toEqual(["auto", "cpu"]);
          expect(native.transcribe.mock.calls.slice(-3, -1).map((call) => call[1])).toEqual([
            { timestamps: "none", language: "en", vocabulary: ["GitHub", "Bob"] },
            {
              timestamps: "none",
              language: "en",
              ...(cpuSupportsVocabulary ? { vocabulary: ["GitHub", "Bob"] } : {}),
            },
          ]);
        }).pipe(Effect.provide(layer));
      }
    }),
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
    for (const cpuSupportsVocabulary of [true, false]) {
      yield* Effect.gen(function* () {
        native.supportsVocabulary = true;
        const feedCalls = native.feed.mock.calls.length;
        const text = { committed: "", tentative: "git hub Robert" };
        const corrected = { committed: "", tentative: "git hub Bob" };
        const options = {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechCustomWords: [
            { term: "GitHub", aliases: [] },
            { term: "Bob", aliases: ["Robert"] },
          ],
        };
        native.feed
          .mockResolvedValueOnce({ revision: 3, text })
          .mockRejectedValueOnce(new Error("worker stopped"))
          .mockResolvedValueOnce({ revision: 1, text })
          .mockResolvedValueOnce({ revision: 2, text })
          .mockResolvedValueOnce({ revision: 3, text });
        loadNative.mockImplementationOnce(async () => native);
        loadNative.mockImplementationOnce(async () => ({
          ...native,
          backend: "CPU",
          supportsVocabulary: cpuSupportsVocabulary,
        }));
        const speech = yield* SpeechService.SpeechService;
        const stream = yield* speech.startStream(options);
        expect(yield* stream.feed(pcm())).toEqual({ revision: 3, text: corrected });
        const recovered = {
          committed: "",
          tentative: cpuSupportsVocabulary ? "git hub Bob" : "GitHub Bob",
        };
        expect(yield* stream.feed(pcm())).toEqual({ revision: 5, text: recovered });
        expect(loadNative.mock.calls.slice(-2).map((call) => call[3])).toEqual(["auto", "cpu"]);
        expect(native.begin.mock.calls.slice(-2)).toEqual([
          ["en", ["GitHub", "Bob"]],
          ["en", cpuSupportsVocabulary ? ["GitHub", "Bob"] : undefined],
        ]);
        expect(native.feed).toHaveBeenCalledTimes(feedCalls + 4);
        expect(yield* stream.feed(pcm())).toEqual({ revision: 6, text: recovered });
        const loads = loadNative.mock.calls.length;
        native.finish.mockRejectedValueOnce(new Error("CPU finish failed"));
        expect(Result.isFailure(yield* Effect.result(stream.finish))).toBe(true);
        expect(Result.isFailure(yield* Effect.result(stream.feed(pcm())))).toBe(true);
        expect(loadNative).toHaveBeenCalledTimes(loads);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }
  }),
);

it.effect.each([false, true])(
  "recovers Auto stream finalization on a fresh CPU worker with retained audio: %s",
  (withAudio) =>
    Effect.gen(function* () {
      const cpu = {
        ...native,
        backend: "CPU",
        begin: vi.fn(async (_language?: string) => {}),
        feed: vi.fn(async (_pcm: Float32Array) => ({
          revision: 1,
          text: { committed: "", tentative: "" },
        })),
        finish: vi.fn(async () => "Robert"),
        dispose: vi.fn(),
      };
      const gpu = {
        ...native,
        finish: vi.fn(async () => {
          throw new Error("GPU finish failed");
        }),
      };
      loadNative.mockResolvedValueOnce(gpu).mockResolvedValueOnce(cpu);
      const speech = yield* SpeechService.SpeechService;
      const chunks = withAudio ? [new Float32Array([0.25, 0]), new Float32Array([-0.5])] : [];
      yield* Effect.gen(function* () {
        const stream = yield* speech.startStream({
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "fr",
          speechCustomWords: [{ term: "Bob", aliases: ["Robert"] }],
        });
        for (const chunk of chunks) yield* stream.feed(new Uint8Array(chunk.buffer));
        expect(yield* stream.finish).toBe("Bob");
        expect(cpu.feed.mock.calls.map(([chunk]) => [...chunk])).toEqual(
          chunks.map((chunk) => [...chunk]),
        );
        expect(cpu.begin).toHaveBeenCalledWith("fr", undefined);
        expect(gpu.dispose).toHaveBeenCalledOnce();
        expect(cpu.dispose).not.toHaveBeenCalled();
        const busy = yield* Effect.result(speech.selectModel("fallback-model"));
        expect(Result.isFailure(busy) && busy.failure).toMatchObject({ _tag: "SpeechBusyError" });
      }).pipe(Effect.scoped);
      expect(loadNative.mock.calls.map(([path, , , acceleration]) => [path, acceleration])).toEqual(
        [
          ["test.gguf", "auto"],
          ["test.gguf", "cpu"],
        ],
      );
      yield* speech.selectModel("fallback-model");
      expect(cpu.dispose).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["auto", 'gpu:["vulkan","gpu-1"]', "cpu"] as const)(
  "reports finalization failure without repeated or explicit-backend fallback: %s",
  (acceleration) =>
    Effect.gen(function* () {
      const failure = new Error("finish failed");
      const worker = {
        ...native,
        backend: acceleration === "cpu" ? "CPU" : "Vulkan0",
        finish: vi.fn(async () => {
          throw failure;
        }),
      };
      const cpu = { ...worker, backend: "CPU", dispose: vi.fn() };
      loadNative.mockResolvedValueOnce(worker);
      if (acceleration === "auto") loadNative.mockResolvedValueOnce(cpu);
      const speech = yield* SpeechService.SpeechService;
      yield* speech.updateAcceleration(acceleration);
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      expect(Result.isFailure(yield* Effect.result(stream.finish))).toBe(true);
      expect(worker.finish).toHaveBeenCalledTimes(acceleration === "auto" ? 2 : 1);
      expect(loadNative).toHaveBeenCalledTimes(acceleration === "auto" ? 2 : 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("does not restart a stream cancelled while native finalization is pending", () =>
  Effect.gen(function* () {
    const pending = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    native.finish.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const speech = yield* SpeechService.SpeechService;
    const streamScope = yield* Scope.make();
    const stream = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.provideService(Scope.Scope, streamScope));
    const request = yield* Effect.result(stream.finish).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* Scope.close(streamScope, Exit.void);
    pending.reject(new Error("cancelled worker stopped"));
    expect(Result.isFailure(yield* Fiber.join(request))).toBe(true);
    expect(loadNative).toHaveBeenCalledOnce();
    expect(native.reset).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);
