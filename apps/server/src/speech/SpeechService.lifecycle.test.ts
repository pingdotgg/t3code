import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { ServerSettingsError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechService from "./SpeechService.ts";

const native = vi.hoisted(() => ({
  backend: "Vulkan0",
  supportsStreaming: true,
  supportsInitialPrompt: false,
  begin: vi.fn(async (_language?: string) => {}),
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
const downloadModel = vi.hoisted(() =>
  vi.fn(async (_directory: string, _model: unknown, _signal?: AbortSignal) => "test.gguf"),
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
  downloadSpeechModel: downloadModel,
  isSpeechModelReady: async (_directory: string, model: { id: string }) =>
    readyModels.has(model.id),
  removeSpeechModel: async (_directory: string, model: { id: string }) => {
    readyModels.delete(model.id);
  },
}));
const layer = SpeechService.layer.pipe(
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-review-" })),
  Layer.provide(ServerSettings.layerTest({ speechModelId: "test-model" })),
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
  downloadModel.mockImplementation(async () => "test.gguf");
});

const customWordsLayer = SpeechService.layer.pipe(
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-custom-words-" })),
  Layer.provide(
    ServerSettings.layerTest({
      speechModelId: "test-model",
      speechCustomWords: [{ term: "T3 Code", aliases: [] }],
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const correctionWordLayer = SpeechService.layer.pipe(
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-correction-word-" })),
  Layer.provide(
    ServerSettings.layerTest({
      speechModelId: "test-model",
      speechCustomWords: [{ term: "T3 Code", aliases: [] }],
      speechCorrectionWord: "err",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect("prepares a batch model before audio arrives and reuses it for transcription", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.selectModel("fallback-model");
    yield* speech.prepareModel;
    expect(loadNative).toHaveBeenCalledTimes(1);
    expect(native.transcribe).not.toHaveBeenCalled();
    expect(yield* speech.transcribe(pcm())).toBe("hello");
    expect(loadNative).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("unloads after the chosen idle period and reloads on the next recording", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("min_2");
    yield* speech.transcribe(pcm());
    yield* TestClock.adjust(2 * 60_000 - 1);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* TestClock.adjust(1);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* speech.transcribe(pcm());
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps prepared batch models through the maximum recording and honors Never", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("min_2");
    yield* speech.prepareModel;
    yield* TestClock.adjust(2 * 60_000);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.updateModelUnloadTimeout("never");
    yield* TestClock.adjust(60 * 60_000);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.updateModelUnloadTimeout("immediately");
    yield* TestClock.adjust(0);
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("waits for an active stream before immediate unloading", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("immediately");
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      yield* TestClock.adjust(60_000);
      expect(native.dispose).not.toHaveBeenCalled();
      yield* stream.finish;
    }).pipe(Effect.scoped);
    yield* TestClock.adjust(0);
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("waits for timer-owned model disposal when the service scope closes", () =>
  Effect.gen(function* () {
    const disposing = Promise.withResolvers<void>();
    const disposed = Promise.withResolvers<void>();
    native.dispose.mockImplementationOnce(() => {
      disposing.resolve();
      return disposed.promise;
    });
    let closed = false;
    const service = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.transcribe(pcm());
      yield* speech.updateModelUnloadTimeout("immediately");
      yield* TestClock.adjust(0);
    }).pipe(
      Effect.provide(layer),
      Effect.tap(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.promise(() => disposing.promise);
    yield* Effect.yieldNow;
    expect(closed).toBe(false);
    disposed.resolve();
    yield* Fiber.join(service);
    expect(closed).toBe(true);
    expect(native.dispose).toHaveBeenCalledOnce();
  }),
);

it.effect("recognizes the correction word without showing it in the dictionary", () =>
  Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "I want orange, er, yellow." });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm())).toBe("I want orange, err, yellow.");
    expect(yield* speech.status).toMatchObject({ customWords: [{ term: "T3 Code", aliases: [] }] });
  }).pipe(Effect.provide(correctionWordLayer)),
);

it.effect("includes the correction word in the model's initial prompt", () =>
  Effect.gen(function* () {
    native.supportsInitialPrompt = true;
    const speech = yield* SpeechService.SpeechService;
    yield* speech.transcribe(pcm());
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({
      family: { kind: "whisper", initialPrompt: "err, T3 Code" },
    });
  }).pipe(Effect.provide(correctionWordLayer)),
);

it.effect("applies the selected language to transcription and streaming", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.updateLanguage("fr")).toMatchObject({
      language: "fr",
      effectiveLanguage: "fr",
    });
    yield* speech.transcribe(pcm());
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({ language: "fr" });
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(native.begin).toHaveBeenCalledWith("fr");
  }).pipe(Effect.provide(layer)),
);

it.effect("recognizes the correction word in stream previews and final text", () =>
  Effect.gen(function* () {
    native.feed.mockResolvedValueOnce({
      revision: 1,
      text: { committed: "orange, er,", tentative: "yellow" },
    });
    native.finish.mockResolvedValueOnce("orange, er, yellow");
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      expect(yield* stream.feed(pcm())).toMatchObject({
        text: { committed: "orange, err,", tentative: "yellow" },
      });
      expect(yield* stream.finish).toBe("orange, err, yellow");
    }).pipe(Effect.scoped);
  }).pipe(Effect.provide(correctionWordLayer)),
);

it.effect("corrects custom words for models without prompt support", () =>
  Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "open t 3 code" });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm())).toBe("open T3 Code");
  }).pipe(Effect.provide(customWordsLayer)),
);

it.effect("passes custom words as an initial prompt when the model supports it", () =>
  Effect.gen(function* () {
    native.supportsInitialPrompt = true;
    const speech = yield* SpeechService.SpeechService;
    yield* speech.transcribe(pcm());
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({
      family: { kind: "whisper", initialPrompt: "T3 Code" },
    });
  }).pipe(Effect.provide(customWordsLayer)),
);

it.effect("applies aliases even when the model accepts a vocabulary prompt", () =>
  Effect.gen(function* () {
    native.supportsInitialPrompt = true;
    native.transcribe.mockResolvedValueOnce({ text: "open t three code" });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm())).toBe("open T3 Code");
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({
      family: { kind: "whisper", initialPrompt: "T3 Code" },
    });
  }).pipe(
    Effect.provide(
      SpeechService.layer.pipe(
        Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-aliases-" })),
        Layer.provide(
          ServerSettings.layerTest({
            speechModelId: "test-model",
            speechCustomWords: [{ term: "T3 Code", aliases: ["t three code"] }],
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("removes filler words from batch transcription", () =>
  Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "Um, I uhh think this works." });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm())).toBe("I think this works.");
  }).pipe(Effect.provide(layer)),
);

it.effect("removes filler words when a stream is finalized", () =>
  Effect.gen(function* () {
    native.finish.mockResolvedValueOnce("Um, I uhh think this works.");
    const speech = yield* SpeechService.SpeechService;
    const result = yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      return yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(result).toBe("I think this works.");
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves filler words when removal is disabled", () => {
  const disabledLayer = SpeechService.layer.pipe(
    Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-fillers-disabled-" })),
    Layer.provide(
      ServerSettings.layerTest({
        speechModelId: "test-model",
        speechRemoveFillerWords: false,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "Um, I uhh think this works." });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm())).toBe("Um, I uhh think this works.");
  }).pipe(Effect.provide(disabledLayer));
});

it.effect("holds model ownership until the stream scope closes and preserves silence", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
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
    yield* speech.startStream.pipe(Effect.scoped);
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      yield* stream.feed(pcm());
      yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("disposes a stream when resetting it fails", () =>
  Effect.gen(function* () {
    native.reset.mockRejectedValueOnce(new Error("reset failed"));
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream.pipe(Effect.scoped);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* speech.startStream.pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.live("stops an unresponsive stream reset and releases the busy slot", () =>
  Effect.gen(function* () {
    native.reset.mockImplementationOnce(() => new Promise(() => {}));
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream.pipe(Effect.scoped);
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(yield* speech.status).toMatchObject({ state: "ready" });
    yield* speech.startStream.pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("releases a stream cancelled while settings are loading", () =>
  Effect.gen(function* () {
    const settingsRead = Promise.withResolvers<void>();
    const delayedSettings = Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        let firstRead = true;
        return {
          ...settings,
          getSettings: Effect.suspend(() => {
            if (!firstRead) return settings.getSettings;
            firstRead = false;
            settingsRead.resolve();
            return Effect.never;
          }),
        };
      }),
    ).pipe(Layer.provide(ServerSettings.layerTest({ speechModelId: "test-model" })));
    const testLayer = SpeechService.layer.pipe(
      Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-cancel-settings-" })),
      Layer.provide(delayedSettings),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const starting = yield* speech.startStream.pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.promise(() => settingsRead.promise);
      yield* Fiber.interrupt(starting);
      yield* Effect.gen(function* () {
        const stream = yield* speech.startStream;
        yield* stream.finish;
      }).pipe(Effect.scoped);
      expect(loadNative).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("recovers the busy slot when a settings read fails", () =>
  Effect.gen(function* () {
    let reads = 0;
    const failingSettings = Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        return {
          ...settings,
          getSettings: Effect.suspend(() => {
            reads += 1;
            if (reads === 1)
              return Effect.fail(
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  operation: "read-file",
                  cause: new Error("settings boom"),
                }),
              );
            return settings.getSettings;
          }),
        };
      }),
    ).pipe(Layer.provide(ServerSettings.layerTest({ speechModelId: "test-model" })));
    const testLayer = SpeechService.layer.pipe(
      Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-failing-settings-" })),
      Layer.provide(failingSettings),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const first = yield* speech.startStream.pipe(Effect.scoped, Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      yield* speech.startStream.pipe(Effect.scoped);
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("reuses the model when a cancelled feed finishes during reset", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof native.feed>>>();
    native.feed.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    native.reset.mockImplementationOnce(async () => {
      pending.resolve({ revision: 1, text: { committed: "", tentative: "hello" } });
      await pending.promise;
    });
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      yield* stream.feed(pcm()).pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
    }).pipe(Effect.scoped);
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.startStream.pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects invalid streaming audio and resets the stream", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const result = yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      yield* stream.feed(new Uint8Array([1, 2, 3]));
    }).pipe(Effect.scoped, Effect.result);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechInvalidAudioError",
      byteLength: 3,
    });
    expect(native.feed).not.toHaveBeenCalled();
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer)),
);
it.effect("preserves a cancelled download during stream preparation", () =>
  Effect.gen(function* () {
    downloadModel.mockRejectedValueOnce(
      new SpeechService.SpeechDownloadCancelledError({ modelId: "test-model" }),
    );
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.startStream.pipe(Effect.scoped));
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechDownloadCancelledError",
      modelId: "test-model",
    });
  }),
);
it.effect("preserves a busy error during stream preparation", () =>
  Effect.gen(function* () {
    loadNative.mockRejectedValueOnce(
      new SpeechService.SpeechBusyError({ operation: "model preparation" }),
    );
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.startStream.pipe(Effect.scoped));
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechBusyError",
      operation: "model preparation",
    });
  }),
);
it.effect("preserves a cancelled download during transcription preparation", () =>
  Effect.gen(function* () {
    downloadModel.mockRejectedValueOnce(
      new SpeechService.SpeechDownloadCancelledError({ modelId: "test-model" }),
    );
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm()));
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechDownloadCancelledError",
      modelId: "test-model",
    });
  }),
);
it.effect("preserves a busy error during transcription preparation", () =>
  Effect.gen(function* () {
    loadNative.mockRejectedValueOnce(
      new SpeechService.SpeechBusyError({ operation: "model preparation" }),
    );
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm()));
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechBusyError",
      operation: "model preparation",
    });
  }),
);
it.effect("releases the loaded native model when its service scope closes", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      expect(yield* speech.transcribe(pcm())).toBe("hello");
      expect(native.dispose).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
    expect(native.dispose).toHaveBeenCalledOnce();
  }),
);
it.effect("preserves invalid PCM errors through the service boundary", () =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(new Uint8Array(3)));
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechInvalidAudioError",
      byteLength: 3,
    });
  }),
);
it.effect("retries accelerated inference on CPU after the native process fails", () =>
  Effect.gen(function* () {
    native.transcribe.mockRejectedValueOnce(new Error("worker stopped"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      expect(yield* speech.transcribe(pcm())).toBe("hello");
      expect(loadNative).toHaveBeenCalledTimes(2);
      expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("uses a selected GPU without falling back to CPU after inference fails", () =>
  Effect.gen(function* () {
    native.transcribe.mockRejectedValueOnce(new Error("GPU failed"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const acceleration = 'gpu:["vulkan","gpu-1"]';
      expect(yield* speech.updateAcceleration(acceleration)).toMatchObject({ acceleration });
      const result = yield* speech.transcribe(pcm()).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(loadNative).toHaveBeenCalledTimes(1);
      expect(loadNative.mock.calls[0]?.[3]).toBe(acceleration);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reports an unavailable selected GPU without loading CPU", () =>
  Effect.gen(function* () {
    loadNative.mockRejectedValueOnce(new Error("The selected speech GPU is unavailable."));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.updateAcceleration('gpu:["vulkan","missing"]');
      const result = yield* speech.transcribe(pcm()).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reloads a cached model after acceleration changes", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.transcribe(pcm());
      yield* speech.updateAcceleration("cpu");
      yield* speech.transcribe(pcm());
      expect(loadNative).toHaveBeenCalledTimes(2);
      expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
      expect(native.dispose).toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("applies an acceleration change after an active stream finishes", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* speech.startStream;
          expect(yield* speech.updateAcceleration("cpu")).toMatchObject({
            state: "transcribing",
            acceleration: "cpu",
          });
          yield* stream.finish;
        }),
      );
      yield* speech.transcribe(pcm());
      expect(loadNative).toHaveBeenCalledTimes(2);
      expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("replays streaming audio on CPU after an accelerated feed crashes", () =>
  Effect.gen(function* () {
    native.feed.mockRejectedValueOnce(new Error("worker stopped"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const stream = yield* speech.startStream;
      expect((yield* stream.feed(pcm())).text).toEqual({ committed: "", tentative: "hello" });
      expect(loadNative).toHaveBeenCalledTimes(2);
      expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
      expect(native.begin).toHaveBeenCalledTimes(2);
      expect(native.feed).toHaveBeenCalledTimes(2);
      yield* stream.finish;
    }).pipe(Effect.scoped, Effect.provide(layer));
  }),
);

it.effect("reports a selected GPU streaming failure without replaying on CPU", () =>
  Effect.gen(function* () {
    native.feed.mockRejectedValueOnce(new Error("GPU failed"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.updateAcceleration('gpu:["vulkan","gpu-1"]');
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* speech.startStream;
          return yield* stream.feed(pcm()).pipe(Effect.result);
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer));
  }),
);
it.effect(
  "reports an explicitly cancelled download without wrapping it as an operation failure",
  () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      downloadModel.mockImplementationOnce(
        async (_directory: string, _model: unknown, signal?: AbortSignal) => {
          started.resolve();
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      );
      yield* Effect.gen(function* () {
        const speech = yield* SpeechService.SpeechService;
        const request = yield* speech.downloadModel("test-model").pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        yield* speech.cancelDownload("test-model");
        const result = yield* Effect.result(Fiber.join(request));
        expect(Result.isFailure(result) && result.failure).toMatchObject({
          _tag: "SpeechDownloadCancelledError",
          modelId: "test-model",
        });
      }).pipe(Effect.provide(layer));
    }),
);
it.effect("reports unsupported hosts without wrapping a synthetic cause", () =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm()));
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessArchitecture, "arm64"),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechUnsupportedPlatformError",
      platform: "win32",
      architecture: "arm64",
    });
  }),
);
it.effect("selects another installed model after removing the active model", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const status = yield* speech.removeModel("test-model");
    expect(status).toMatchObject({
      supported: true,
      state: "ready",
      modelId: "fallback-model",
    });
    expect(
      (yield* speech.models).models.find((model) => model.id === "fallback-model")?.active,
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);
it.effect("does not mark a deleted model active when no models remain installed", () =>
  Effect.gen(function* () {
    readyModels.delete("fallback-model");
    const speech = yield* SpeechService.SpeechService;
    const status = yield* speech.removeModel("test-model");
    expect(status).toMatchObject({ supported: true, state: "missing-model" });
    expect((yield* speech.models).models.every((model) => !model.active)).toBe(true);
  }).pipe(Effect.provide(layer)),
);
it.live("frees a cancelled batch transcription and preempts it on retry", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    native.transcribe.mockImplementationOnce(() => {
      started.resolve();
      return new Promise<never>(() => {});
    });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const request = yield* speech.transcribe(pcm()).pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
      // The slot is free immediately while abandoned work still runs.
      expect(yield* speech.status).toMatchObject({ state: "ready" });
      expect(native.dispose).not.toHaveBeenCalled();
      // The retry waits out the grace period, stops the orphan, and reloads.
      expect(yield* speech.transcribe(pcm())).toBe("hello");
      expect(native.dispose).toHaveBeenCalledOnce();
      expect(loadNative).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reuses the model when abandoned batch work finishes first", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<{ text: string }>();
    native.transcribe.mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const request = yield* speech.transcribe(pcm()).pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
      gate.resolve({ text: "late hello" });
      expect(yield* speech.transcribe(pcm())).toBe("hello");
      expect(native.dispose).not.toHaveBeenCalled();
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "closes its scope without waiting for hung native inference",
  () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      native.transcribe.mockImplementationOnce(() => {
        started.resolve();
        return new Promise(() => {});
      });
      yield* Effect.gen(function* () {
        const speech = yield* SpeechService.SpeechService;
        const request = yield* speech.transcribe(pcm()).pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(request);
      }).pipe(Effect.provide(layer));
      expect(native.dispose).toHaveBeenCalledOnce();
    }),
  { timeout: 1000 },
);

it.effect("retains warmup ownership after cancellation until its load settles", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<typeof native>();
    loadNative.mockImplementationOnce(async () => {
      started.resolve();
      return pending.promise;
    });
    const speech = yield* SpeechService.SpeechService;
    const warmup = yield* speech.prepareModel.pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(warmup).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    const selection = yield* Effect.result(speech.selectModel("fallback-model"));
    pending.resolve(native);
    yield* Fiber.await(warmup);
    expect(Result.isFailure(selection) && selection.failure).toMatchObject({
      _tag: "SpeechBusyError",
    });
    yield* speech.selectModel("fallback-model");
    yield* speech.prepareModel;
    expect(loadNative).toHaveBeenCalledTimes(2);
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("a failed stream begin does not poison the next stream", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    native.begin.mockRejectedValueOnce(new Error("native stream creation failed"));
    const result = yield* speech.startStream.pipe(Effect.scoped, Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* speech.startStream.pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("failed CPU fallback is disposed", () =>
  Effect.gen(function* () {
    native.transcribe.mockRejectedValueOnce(new Error("GPU failed"));
    native.transcribe.mockRejectedValueOnce(new Error("CPU failed"));
    const speech = yield* SpeechService.SpeechService;
    yield* speech.transcribe(pcm()).pipe(Effect.result);
    expect(native.dispose).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);
