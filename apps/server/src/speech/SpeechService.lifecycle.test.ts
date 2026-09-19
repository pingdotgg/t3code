import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechService from "./SpeechService.ts";

const native = vi.hoisted(() => ({
  backend: "Vulkan0",
  supportsStreaming: true,
  supportsInitialPrompt: false,
  begin: vi.fn(async () => {}),
  feed: vi.fn(async (_pcm: Float32Array) => ({
    revision: 1,
    text: { committed: "", tentative: "hello" },
  })),
  finish: vi.fn(async () => "hello"),
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
    languages: ["en"],
    accuracy: 1,
    speed: 1,
    recommended: true,
    supportsStreaming: true,
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
  },
]);
vi.mock("./native.ts", () => ({ loadNativeSpeechModel: loadNative }));
vi.mock("./model.ts", () => ({
  DEFAULT_SPEECH_MODEL_ID: "test-model",
  SPEECH_MODELS: modelDefinitions,
  getSpeechModel: (modelId: string) => modelDefinitions.find((model) => model.id === modelId),
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
    ServerSettings.layerTest({ speechModelId: "test-model", speechCustomWords: ["T3 Code"] }),
  ),
  Layer.provide(NodeServices.layer),
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

it.effect("disposes cancelled streams and allows another recording", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream.pipe(Effect.scoped);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      yield* stream.feed(pcm());
      yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects invalid streaming audio and frees the model", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const result = yield* Effect.gen(function* () {
      const stream = yield* speech.startStream;
      yield* stream.feed(new Uint8Array([1, 2, 3]));
    }).pipe(Effect.scoped, Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(native.feed).not.toHaveBeenCalled();
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
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
it.effect("retains ownership of native work after its request is interrupted", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<{ text: string }>();
    native.transcribe.mockImplementationOnce(() => {
      started.resolve();
      return completed.promise;
    });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const request = yield* speech.transcribe(pcm()).pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
      expect(native.dispose).not.toHaveBeenCalled();
      const removal = yield* Effect.result(speech.removeModel("test-model"));
      expect(Result.isFailure(removal) && removal.failure).toMatchObject({
        _tag: "SpeechBusyError",
      });
      const second = yield* Effect.result(speech.transcribe(pcm()));
      expect(Result.isFailure(second) && second.failure).toMatchObject({ _tag: "SpeechBusyError" });
      completed.resolve({ text: "late result" });
    }).pipe(Effect.provide(layer));
    expect(native.dispose).toHaveBeenCalledOnce();
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
