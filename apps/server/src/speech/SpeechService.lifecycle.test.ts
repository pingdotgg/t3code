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
  dispose: vi.fn(),
  transcribe: vi.fn(async () => ({ text: "hello" })),
}));
const loadNative = vi.hoisted(() => vi.fn(async () => native));
const downloadModel = vi.hoisted(() =>
  vi.fn(async (_directory: string, _model: unknown, _signal?: AbortSignal) => "test.gguf"),
);
vi.mock("./native.ts", () => ({ loadNativeSpeechModel: loadNative }));
vi.mock("./model.ts", () => ({
  DEFAULT_SPEECH_MODEL_ID: "test-model",
  SPEECH_MODELS: [
    {
      id: "test-model",
      name: "test",
      description: "test",
      size: 4,
      languages: ["en"],
      accuracy: 1,
      speed: 1,
      recommended: true,
    },
  ],
  getSpeechModel: () => ({
    id: "test-model",
    name: "test",
    description: "test",
    size: 4,
    languages: ["en"],
    accuracy: 1,
    speed: 1,
    recommended: true,
  }),
  downloadSpeechModel: downloadModel,
  isSpeechModelReady: async () => true,
  removeSpeechModel: async () => {},
}));
const layer = SpeechService.layer.pipe(
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-review-" })),
  Layer.provide(ServerSettings.layerTest({ speechModelId: "test-model" })),
  Layer.provide(NodeServices.layer),
);
const pcm = () => new Uint8Array(new Float32Array([0.25]).buffer);
beforeEach(() => {
  vi.clearAllMocks();
  downloadModel.mockImplementation(async () => "test.gguf");
});
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
it.effect("reloads the native model after inference fails", () =>
  Effect.gen(function* () {
    native.transcribe.mockRejectedValueOnce(new Error("worker stopped"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      expect(Result.isFailure(yield* Effect.result(speech.transcribe(pcm())))).toBe(true);
      expect(yield* speech.transcribe(pcm())).toBe("hello");
      expect(loadNative).toHaveBeenCalledTimes(2);
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
