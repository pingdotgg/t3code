import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { listNativeSpeechGpuDevices } from "./native.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechService from "./SpeechService.ts";
import { SILERO_VAD } from "./silero.ts";

const native = vi.hoisted(() => ({
  backend: "Vulkan0",
  supportsStreaming: true,
  supportsLongForm: false,
  supportsTranslation: true,
  supportsVocabulary: false,
  languages: ["en", "fr"] as readonly string[],
  begin: vi.fn(async (_options?: unknown, _filterSilence?: boolean, _vadPath?: string) => {}),
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
    benchmark: {
      accuracy: { en: { grade: "A-", errorPercent: 4 } },
      secondsPer30s: { cpu: 3, accelerated: 1.2 },
    },
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
    languages: ["en", "fr"],
    accuracy: 2,
    speed: 2,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: true,
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
    link: () => Effect.succeed([]),
    linkedFrom: () => Effect.undefined,
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
  native.finish.mockReset();
  native.backend = "Vulkan0";
  native.supportsVocabulary = false;
  native.supportsStreaming = true;
  native.languages = ["en", "fr"];
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

it.effect.each(["CPU", "Vulkan0"])(
  "prepares a batch model on %s before audio arrives and reuses it for transcription",
  (backend) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.selectModel("fallback-model");
      loadNative.mockImplementationOnce(async () => {
        native.backend = backend;
        return native;
      });
      yield* speech.prepareModel;
      expect(yield* speech.status).toMatchObject({
        benchmarkTier: backend === "CPU" ? "cpu" : "accelerated",
      });
      expect(loadNative).toHaveBeenCalledTimes(1);
      expect(native.transcribe).not.toHaveBeenCalled();
      native.supportsStreaming = false;
      yield* Effect.gen(function* () {
        const stream = yield* speech.startStream({
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "fr",
          speechTranslateToEnglish: true,
          speechSilenceFiltering: false,
        });
        expect(native.begin).toHaveBeenLastCalledWith(
          { timestamps: "none", language: "fr", task: "translate", targetLanguage: "en" },
          false,
          "test.gguf",
        );
        expect(yield* stream.finish).toBe("hello");
      }).pipe(Effect.scoped);
      expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer)),
);

it.effect("sends the chosen language in the spelling the loaded model advertises", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    // Nemotron Streaming 3.5 advertises regional tags while the catalog lists bare codes.
    native.languages = ["en-US", "en-GB", "fr-FR"];
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "fr",
      });
      expect(native.begin).toHaveBeenLastCalledWith(
        { timestamps: "none", language: "fr-FR" },
        true,
        "test.gguf",
      );
      expect(yield* stream.finish).toBe("hello");
    }).pipe(Effect.scoped);
    native.supportsStreaming = false;
    expect(
      yield* speech.transcribe(pcm(), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "fr",
      }),
    ).toBe("hello");
    expect(native.transcribe).toHaveBeenLastCalledWith(
      expect.any(Float32Array),
      { timestamps: "none", language: "fr-FR" },
      true,
      "test.gguf",
    );
    // A language the model does not advertise reaches it unchanged, so the model reports it.
    yield* speech.updateAcceleration("cpu");
    native.languages = ["en-US"];
    native.transcribe.mockRejectedValueOnce(new Error("transcribe_run: unsupported language"));
    const rejected = yield* Effect.result(
      speech.transcribe(pcm(), { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "fr" }),
    );
    expect(Result.isFailure(rejected) && rejected.failure).toMatchObject({
      _tag: "SpeechOperationError",
      operation: "inference",
    });
    expect(native.transcribe).toHaveBeenLastCalledWith(
      expect.any(Float32Array),
      { timestamps: "none", language: "fr" },
      true,
      "test.gguf",
    );
    expect(loadNative.mock.calls.map(([path, , , acceleration]) => [path, acceleration])).toEqual([
      ["test.gguf", "auto"],
      ["test.gguf", "cpu"],
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["cancellation", "timeout"] as const)(
  "releases a stalled model preparation on %s",
  (reason) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const started = Promise.withResolvers<AbortSignal>();
      const stalled = Promise.withResolvers<typeof native>();
      const disposed = Promise.withResolvers<void>();
      const abandoned = { ...native, dispose: vi.fn(() => disposed.resolve()) };
      loadNative.mockImplementationOnce((_path, signal) => {
        started.resolve(signal);
        return stalled.promise;
      });
      const request = yield* speech.prepareModel.pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      try {
        if (reason === "cancellation") {
          yield* Fiber.interrupt(request).pipe(Effect.forkChild({ startImmediately: true }));
        }
        yield* TestClock.adjust(reason === "timeout" ? "2 minutes" : 0);
        expect(signal.aborted).toBe(true);
        const exit = yield* Fiber.await(request);
        expect(Exit.isFailure(exit)).toBe(true);
        if (reason === "timeout") {
          expect(Exit.findErrorOption(exit)).toMatchObject({
            value: { _tag: "SpeechOperationError", operation: "model preparation" },
          });
        }
        yield* speech.selectModel("fallback-model");
        const transcribe = speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
        expect(yield* transcribe).toBe("hello");
        stalled.resolve(abandoned);
        yield* Effect.promise(() => disposed.promise);
        expect(yield* transcribe).toBe("hello");
        expect(loadNative).toHaveBeenCalledTimes(2);
      } finally {
        stalled.resolve(abandoned);
      }
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
    const current = (yield* speech.models(false)).models.find((model) => model.active);
    expect(current?.id).toBe("test-model");
    expect(current).not.toHaveProperty("benchmark");
    expect(
      (yield* speech.models(true)).models.find((model) => model.active)?.benchmark?.secondsPer30s,
    ).toEqual({ cpu: 3, accelerated: 1.2 });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a detached download exclusive until the transfer finishes", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const helperStarted = yield* Deferred.make<void>();
    let helperStartedDuringInstall = false;
    let helperInterrupted = false;
    download
      .mockImplementationOnce(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as("test.gguf"),
        ),
      )
      .mockImplementationOnce(() =>
        Deferred.isDone(finish).pipe(
          Effect.tap((done) =>
            Effect.sync(() => {
              helperStartedDuringInstall = !done;
            }),
          ),
          Effect.andThen(Deferred.succeed(helperStarted, undefined)),
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              helperInterrupted = true;
            }),
          ),
        ),
      );
    const request = yield* speech.downloadModel("test-model").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Deferred.await(helperStarted);
    yield* Fiber.interrupt(request);
    yield* Deferred.succeed(finish, undefined);
    yield* TestClock.adjust("16 seconds");
    expect(helperInterrupted).toBe(false);
    const removed = yield* Effect.result(speech.removeModel("test-model"));
    expect(Result.isFailure(removed) && removed.failure).toMatchObject({ _tag: "SpeechBusyError" });
    const join = yield* speech
      .downloadModel("test-model")
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("2 minutes");
    expect(helperInterrupted).toBe(true);
    yield* Fiber.join(join);
    expect(download.mock.calls.map(([model]) => model.id)).toEqual(["test-model", SILERO_VAD.id]);
    expect(helperStartedDuringInstall).toBe(true);
    yield* speech.removeModel("test-model");
    expect(readyModels.has("test-model")).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds missing Silero recovery during recording and continues with raw audio", () =>
  Effect.gen(function* () {
    const helperStarted = yield* Deferred.make<void>();
    const helperInterrupted = yield* Deferred.make<void>();
    download.mockImplementationOnce(() =>
      Deferred.succeed(helperStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(helperInterrupted, undefined)),
      ),
    );
    const speech = yield* SpeechService.SpeechService;
    const recording = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.forkChild);
    yield* Deferred.await(helperStarted);
    yield* TestClock.adjust("14999 millis");
    expect(native.begin).not.toHaveBeenCalled();
    yield* TestClock.adjust("1 millis");
    yield* Deferred.await(helperInterrupted);
    const stream = yield* Fiber.join(recording);
    expect(native.begin).toHaveBeenLastCalledWith(expect.anything(), true, undefined);
    yield* stream.feed(pcm());
    expect(yield* stream.finish).toBe("hello");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps the installed speech model usable when optional Silero acquisition fails", () =>
  Effect.gen(function* () {
    download
      .mockImplementationOnce(() => Effect.succeed("test.gguf"))
      .mockImplementationOnce(() =>
        Effect.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "open",
            }),
          ),
        ),
      );
    const speech = yield* SpeechService.SpeechService;
    const installed = yield* speech.downloadModel("test-model");
    expect(installed.models.find((model) => model.id === "test-model")?.state).toBe("installed");
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
        expect(yield* stream.finish).toBe("hello");
      }),
    );
    expect(download).toHaveBeenCalledTimes(2);
    yield* TestClock.adjust("10 minutes");
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    expect(download).toHaveBeenCalledTimes(3);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "allows another model operation after an already-installed download completes immediately",
  () =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const models = yield* speech.downloadModel("test-model").pipe(
        Effect.provideService(Scheduler.Scheduler, {
          executionMode: "sync",
          shouldYield: () => false,
          makeDispatcher: () => ({ scheduleTask: (task) => task(), flush: () => {} }),
        }),
      );
      expect(models.models.find((model) => model.id === "test-model")?.state).toBe("installed");
      yield* speech.selectModel("fallback-model");
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
          expect(native.begin.mock.lastCall).toEqual([
            { timestamps: "none", language: "fr", ...(vocabulary ? { vocabulary } : {}) },
            true,
            "test.gguf",
          ]);
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

it.effect.each([
  {
    cue: undefined,
    remove: true,
    text: "First paragraph.\n\nSecond paragraph.",
    expected: "First paragraph.\n\nSecond paragraph.",
  },
  {
    cue: undefined,
    remove: true,
    text: "First um\n\nuh Second.",
    expected: "First\n\nSecond.",
  },
  {
    cue: undefined,
    remove: true,
    text: "First um\r\n\r\nuh Second.",
    expected: "First\r\n\r\nSecond.",
  },
  { cue: "um", remove: true, text: "Make it red, um, blue.", expected: "Make it red, um, blue." },
  {
    cue: "uh no",
    remove: true,
    text: "Make it red, uh no, blue.",
    expected: "Make it red, uh no, blue.",
  },
  {
    cue: "uh no",
    remove: true,
    text: "Uh, Make it red, UH  NO, blue. Uh nope.",
    expected: "Make it red, UH NO, blue. nope.",
  },
  {
    cue: " UM ",
    remove: true,
    text: "Uh, Make it red, um, blue.",
    expected: "Make it red, um, blue.",
  },
  {
    cue: undefined,
    remove: true,
    text: "Uh, Make it red, um, blue.",
    expected: "Make it red, blue.",
  },
  {
    cue: "um",
    remove: false,
    text: "Uh, Make it red, um, blue.",
    expected: "Uh, Make it red, um, blue.",
  },
])(
  "preserves only an explicit correction cue during batch and stream filler removal: $cue / $remove",
  ({ cue, remove, text, expected }) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const options = {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "en",
        speechRemoveFillerWords: remove,
        speechCustomWords: [{ term: "um", aliases: [] }],
        ...(cue === undefined ? {} : { speechCorrectionWord: cue }),
      };
      native.transcribe.mockResolvedValueOnce({ text });
      native.finish.mockResolvedValueOnce(text);
      expect(yield* speech.transcribe(pcm(), options)).toBe(expected);
      const stream = yield* speech.startStream(options);
      expect(yield* stream.finish).toBe(expected);
    }).pipe(Effect.scoped, Effect.provide(layer)),
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

it.effect("releases a failed stream start without waiting for its socket scope to close", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const socket = yield* Scope.fork(yield* Effect.scope);
    yield* speech.updateAcceleration("cpu");
    native.begin.mockRejectedValueOnce(new Error("cannot start streaming"));
    const error = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Scope.provide(socket), Effect.flip);
    expect(error._tag).toBe("SpeechOperationError");
    expect(yield* speech.status).toMatchObject({ state: "ready" });
    expect(native.dispose).toHaveBeenCalledOnce();
    const next = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    yield* Scope.close(socket, Exit.void);
    expect(yield* speech.status).toMatchObject({ state: "transcribing" });
    expect(yield* next.finish).toBe("hello");
  }).pipe(Effect.scoped, Effect.provide(layer)),
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

it.effect.each([{ devices: [] }, { devices: [{ id: "gpu", name: "Test GPU" }] }])(
  "retries failed GPU discovery without repeatedly probing on status polls: $devices",
  ({ devices }) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const discover = vi.mocked(listNativeSpeechGpuDevices).mockReset();
      discover.mockRejectedValueOnce(new Error("driver not ready")).mockResolvedValueOnce(devices);
      expect(yield* speech.status).toMatchObject({ gpuDevices: [], benchmarkTier: "cpu" });
      yield* speech.status;
      expect(discover).toHaveBeenCalledOnce();
      yield* TestClock.adjust("1 minute");
      expect(yield* speech.status).toMatchObject({
        gpuDevices: devices,
        benchmarkTier: devices.length ? "accelerated" : "cpu",
      });
      expect(yield* speech.updateAcceleration("cpu")).toMatchObject({ benchmarkTier: "cpu" });
      expect(yield* speech.updateAcceleration('gpu:["vulkan","gpu-1"]')).toMatchObject({
        benchmarkTier: "accelerated",
      });
      yield* speech.updateAcceleration("auto");
      yield* TestClock.adjust("1 minute");
      expect(yield* speech.status).toMatchObject({ gpuDevices: devices });
      expect(discover).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
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
          expect(yield* speech.status).toMatchObject({ benchmarkTier: "accelerated" });
          expect(yield* speech.transcribe(pcm(), options)).toBe(
            cpuSupportsVocabulary ? "git hub Bob" : "GitHub Bob",
          );
          expect(yield* speech.status).toMatchObject({ benchmarkTier: "cpu" });
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
        expect(native.begin.mock.calls.slice(-2).map(([options]) => options)).toEqual([
          { timestamps: "none", language: "en", vocabulary: ["GitHub", "Bob"] },
          {
            timestamps: "none",
            language: "en",
            ...(cpuSupportsVocabulary ? { vocabulary: ["GitHub", "Bob"] } : {}),
          },
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
        begin: vi.fn(async (_options?: unknown) => {}),
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
        expect(cpu.begin).toHaveBeenCalledWith(
          { timestamps: "none", language: "fr" },
          true,
          "test.gguf",
        );
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
