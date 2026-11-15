import * as Context from "effect/Context";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { DEFAULT_SPEECH_OUTPUT_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { expect, vi } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PiperRuntime from "./PiperRuntime.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import { SPEECH_VOICES } from "./voices.ts";
import * as SpeechSynthesisService from "./SpeechSynthesisService.ts";

const wave = () => {
  const audio = new Uint8Array(46);
  audio.set(new TextEncoder().encode("RIFF"));
  audio.set(new TextEncoder().encode("WAVE"), 8);
  return audio;
};
const dependencies = Layer.mergeAll(
  Layer.mock(PiperRuntime.PiperRuntime)({
    executable: Effect.succeed("/managed/piper"),
    status: Effect.succeed({ state: "ready", platform: "linux-x64" }),
  }),
  Layer.mock(SpeechModelStore.SpeechModelStore)({
    isReady: () => Effect.succeed(false),
    installedPath: () => Effect.undefined,
  }),
  NodeServices.layer,
  FetchHttpClient.layer,
  Layer.mock(SecretResolver.SecretResolver)({}),
);
const success = {
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
} as const;

it.effect("keeps local failures local and rejects invalid text before sending text", () =>
  Effect.gen(function* () {
    const run = vi.fn(() => Effect.succeed(success));
    const upstream = vi.fn<typeof fetch>(async () => new Response(wave()));
    const service = Context.get(
      yield* Layer.build(
        SpeechSynthesisService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({ cloudSpeechCredentials: { openai: "fixture" } }),
          ),
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
          Layer.provide(dependencies),
        ),
      ),
      SpeechSynthesisService.SpeechSynthesisService,
    );
    expect(
      yield* Effect.flip(
        service
          .synthesize({ text: "Olá", engine: "piper" })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      ),
    ).toMatchObject({ reason: "not-configured" });
    expect(
      yield* Effect.flip(
        service
          .synthesize({ text: " ", engine: "piper" })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      ),
    ).toMatchObject({ reason: "invalid-text" });
    expect(run).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, vi.fn()), Effect.scoped),
);

it.effect("returns local WAV and removes temporary output after success or interruption", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const model = `${directory}/voice.onnx`;
    yield* fs.writeFile(model, new Uint8Array([1]));
    let output = "";
    let block = false;
    const started = yield* Deferred.make<void>();
    const run = (input: ProcessRunner.ProcessRunInput) =>
      Effect.gen(function* () {
        output = input.args[input.args.length - 1]!;
        expect(input.stdin).toBe("Olá $USER\n");
        if (block) {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }
        yield* fs.writeFile(output, wave()).pipe(Effect.orDie);
        return success;
      });
    const service = Context.get(
      yield* Layer.build(
        SpeechSynthesisService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              speechOutput: {
                ...DEFAULT_SPEECH_OUTPUT_SETTINGS,
                piperVoiceId: "pt_BR-faber-medium",
              },
            }),
          ),
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
          Layer.provide(
            Layer.mock(SpeechModelStore.SpeechModelStore)({
              installedPath: () => Effect.succeed(model),
            }),
          ),
          Layer.provide(dependencies),
        ),
      ),
      SpeechSynthesisService.SpeechSynthesisService,
    );
    expect(Array.from(yield* service.synthesize({ text: "Olá $USER", engine: "piper" }))).toEqual(
      Array.from(wave()),
    );
    expect(yield* fs.exists(output)).toBe(false);
    block = true;
    const pending = yield* service
      .synthesize({ text: "Olá $USER", engine: "piper" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(pending);
    expect(yield* fs.exists(output.slice(0, output.lastIndexOf("/")))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses only the explicitly selected external engine and returns bounded WAV", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async () => new Response(wave()));
    const run = vi.fn(() => Effect.succeed(success));
    const service = Context.get(
      yield* Layer.build(
        SpeechSynthesisService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              cloudSpeechCredentials: { openai: "fixture" },
            }),
          ),
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
          Layer.provide(dependencies),
        ),
      ),
      SpeechSynthesisService.SpeechSynthesisService,
    );
    const synthesize = service
      .synthesize({ text: "Olá", engine: "openai" })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(yield* synthesize).toEqual(wave());
    expect(run).not.toHaveBeenCalled();
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/audio/speech");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
    expect(JSON.parse(String(init?.body))).toMatchObject({ input: "Olá", response_format: "wav" });
    upstream.mockResolvedValueOnce(new Response("private upstream details", { status: 500 }));
    expect(yield* Effect.flip(synthesize)).toMatchObject({ reason: "unavailable" });
    upstream.mockResolvedValueOnce(new Response("invalid audio"));
    expect(yield* Effect.flip(synthesize)).toMatchObject({ reason: "invalid-audio" });
  }).pipe(Effect.scoped),
);

it.effect(
  "installs complete voice bundles, selects them, and cleans up removal, failure, or cancellation",
  () =>
    Effect.gen(function* () {
      const voice = SPEECH_VOICES.find((voice) => voice.id === "pt_BR-faber-medium")!;
      const installed = new Set<string>();
      let blocked = false;
      let failDownload = false;
      const started = yield* Deferred.make<void>();
      const download = vi.fn<SpeechModelStore.SpeechModelStore["Service"]["download"]>(
        (file, progress) =>
          Effect.gen(function* () {
            progress?.onProgress?.(file.size / 2);
            if (failDownload && file.filename.endsWith(".onnx.json"))
              return yield* new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: HttpClientRequest.get("https://huggingface.co/fixture"),
                  cause: new Error("offline"),
                }),
              });
            if (blocked && file.filename.endsWith(".onnx.json")) {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            progress?.onVerificationStart?.();
            installed.add(file.filename);
            return `/managed/${file.filename}`;
          }),
      );
      const store = Layer.mock(SpeechModelStore.SpeechModelStore)({
        isReady: (file) => Effect.sync(() => installed.has(file.filename)),
        installedPath: (file) =>
          Effect.sync(() =>
            installed.has(file.filename) ? `/managed/${file.filename}` : undefined,
          ),
        download,
        remove: (file) =>
          Effect.sync(() => {
            installed.delete(file.filename);
          }),
      });
      const service = Context.get(
        yield* Layer.build(
          SpeechSynthesisService.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(store),
            Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
            Layer.provide(dependencies),
          ),
        ),
        SpeechSynthesisService.SpeechSynthesisService,
      );
      expect(yield* Effect.flip(service.selectVoice(voice.id))).toMatchObject({
        reason: "voice-not-installed",
      });
      expect(
        (yield* service.downloadVoice(voice.id)).voices.find((entry) => entry.id === voice.id),
      ).toMatchObject({ state: "installed", active: false });
      expect(installed.size).toBe(3);
      expect(
        (yield* service.selectVoice(voice.id)).voices.find((entry) => entry.id === voice.id),
      ).toMatchObject({ state: "installed", active: true });
      expect(
        (yield* service.removeVoice(voice.id)).voices.find((entry) => entry.id === voice.id),
      ).toMatchObject({ state: "downloadable", active: false });
      expect(installed.size).toBe(0);
      blocked = true;
      const first = yield* service.downloadVoice(voice.id).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const current = (yield* service.voices).voices.find((entry) => entry.id === voice.id)!;
      expect(current.state).toBe("downloading");
      expect(current.downloaded).toBeGreaterThan(0);
      expect(yield* Effect.flip(service.removeVoice(voice.id))).toMatchObject({ reason: "busy" });
      expect(yield* Effect.flip(service.selectVoice(voice.id))).toMatchObject({ reason: "busy" });
      expect(
        yield* Effect.flip(
          service.downloadVoice(SPEECH_VOICES.find((entry) => entry.id !== voice.id)!.id),
        ),
      ).toMatchObject({ reason: "busy" });
      yield* service.cancelVoiceDownload(voice.id);
      const result = yield* Fiber.join(first);
      expect(result.voices.find((entry) => entry.id === voice.id)).toMatchObject({
        state: "downloadable",
        active: false,
      });
      expect(installed.size).toBe(0);
      blocked = false;
      failDownload = true;
      expect(yield* Effect.flip(service.downloadVoice(voice.id))).toMatchObject({
        _tag: "SpeechSynthesisOperationError",
      });
      expect(installed.size).toBe(0);
      installed.add(voice.files[0]!.filename);
      expect(yield* Effect.flip(service.downloadVoice(voice.id))).toMatchObject({
        _tag: "SpeechSynthesisOperationError",
      });
      expect([...installed]).toEqual([voice.files[0]!.filename]);
      failDownload = false;
      expect(
        (yield* service.downloadVoice(voice.id)).voices.find((entry) => entry.id === voice.id)
          ?.state,
      ).toBe("installed");
      expect(yield* Effect.flip(service.downloadVoice("../not-a-voice"))).toMatchObject({
        reason: "voice-not-found",
      });
    }).pipe(Effect.scoped),
);
