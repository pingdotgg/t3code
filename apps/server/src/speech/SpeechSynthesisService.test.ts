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

it.effect.each(["openai", "elevenlabs"] as const)(
  "uses only the selected %s engine and returns bounded WAV",
  (engine) =>
    Effect.gen(function* () {
      const pcm = new Uint8Array([0, 0, 1, 0]);
      const upstream = vi.fn<typeof fetch>(
        async () =>
          new Response(engine === "elevenlabs" ? pcm : wave(), {
            headers: { "content-type": "audio/wav" },
          }),
      );
      const run = vi.fn(() => Effect.succeed(success));
      const service = Context.get(
        yield* Layer.build(
          SpeechSynthesisService.layer.pipe(
            Layer.provide(
              ServerSettings.layerTest({
                cloudSpeechCredentials: { openai: "openai-fixture" },
                speechOutput: {
                  ...DEFAULT_SPEECH_OUTPUT_SETTINGS,
                  elevenLabsApiKey: "eleven-fixture",
                },
              }),
            ),
            Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
            Layer.provide(dependencies),
          ),
        ),
        SpeechSynthesisService.SpeechSynthesisService,
      );
      const synthesize = service
        .synthesize({ text: "Olá", engine })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      const catalog = yield* service.voices;
      expect(catalog.providers?.find((provider) => provider.id === engine)).toMatchObject({
        configured: true,
        defaultVoice:
          engine === "openai" ? "coral" : DEFAULT_SPEECH_OUTPUT_SETTINGS.elevenLabsVoiceId,
      });
      const audio = yield* synthesize;
      if (engine === "elevenlabs") {
        expect(audio.subarray(44)).toEqual(pcm);
        const header = new DataView(audio.buffer, audio.byteOffset, 44);
        expect(new TextDecoder().decode(audio.subarray(0, 4))).toBe("RIFF");
        expect(new TextDecoder().decode(audio.subarray(8, 16))).toBe("WAVEfmt ");
        expect(header.getUint32(4, true)).toBe(audio.length - 8);
        expect(header.getUint16(20, true)).toBe(1);
        expect(header.getUint16(22, true)).toBe(1);
        expect(header.getUint32(24, true)).toBe(24000);
        expect(header.getUint32(28, true)).toBe(48000);
        expect(header.getUint16(32, true)).toBe(2);
        expect(header.getUint16(34, true)).toBe(16);
        expect(header.getUint32(40, true)).toBe(pcm.length);
      } else expect(audio).toEqual(wave());
      expect(run).not.toHaveBeenCalled();
      const [url, init] = upstream.mock.calls[0]!;
      expect(String(url)).toBe(
        engine === "elevenlabs"
          ? `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_SPEECH_OUTPUT_SETTINGS.elevenLabsVoiceId}?output_format=pcm_24000`
          : "https://api.openai.com/v1/audio/speech",
      );
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("traceparent")).toBeNull();
      expect(headers.get(engine === "elevenlabs" ? "authorization" : "xi-api-key")).toBeNull();
      expect(headers.get(engine === "elevenlabs" ? "xi-api-key" : "authorization")).toBe(
        engine === "elevenlabs" ? "eleven-fixture" : "Bearer openai-fixture",
      );
      expect(JSON.parse(String(init?.body))).toEqual(
        engine === "elevenlabs"
          ? { text: "Olá", model_id: "eleven_multilingual_v2" }
          : { model: "gpt-4o-mini-tts", input: "Olá", voice: "coral", response_format: "wav" },
      );
      for (const [status, reason] of [
        [500, "unavailable"],
        [401, "rejected-key"],
        [429, "rate-limit"],
      ] as const) {
        let signal: AbortSignal | undefined;
        upstream.mockImplementationOnce(async (_url, init) => {
          signal = init?.signal ?? undefined;
          return new Response(new ReadableStream(), { status });
        });
        expect(yield* Effect.flip(synthesize)).toMatchObject({ reason });
        expect(signal?.aborted).toBe(true);
      }
      const voice = engine === "elevenlabs" ? "different-voice" : "nova";
      yield* service
        .synthesize({ text: "Scoped voice", engine, voice })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      const [scopedUrl, scopedInit] = upstream.mock.calls.at(-1)!;
      if (engine === "elevenlabs") expect(String(scopedUrl)).toContain("/different-voice?");
      else expect(JSON.parse(String(scopedInit?.body)).voice).toBe("nova");
      const calls = upstream.mock.calls.length;
      expect(
        yield* Effect.flip(
          service.synthesize({ text: "Invalid voice", engine, voice: "https://invalid/voice" }),
        ),
      ).toMatchObject({ reason: "voice-not-found" });
      expect(upstream).toHaveBeenCalledTimes(calls);
      upstream.mockResolvedValueOnce(new Response("invalid audio"));
      expect(yield* Effect.flip(synthesize)).toMatchObject({ reason: "invalid-audio" });
      if (engine === "elevenlabs") {
        upstream.mockResolvedValueOnce(
          new Response("{}", { headers: { "content-type": "application/json" } }),
        );
        expect(yield* Effect.flip(synthesize)).toMatchObject({ reason: "invalid-audio" });
        upstream.mockResolvedValueOnce(new Response(new Uint8Array()));
        expect(yield* Effect.flip(synthesize)).toMatchObject({ reason: "invalid-audio" });
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "loads ElevenLabs voices with the chosen key, validates pagination, and sanitizes failures",
  () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () =>
        Response.json({
          voices: [{ voice_id: "voice-1", name: "  Faber  " }],
          has_more: true,
          next_page_token: "cursor&secret=kept",
        }),
      );
      const context = yield* Layer.build(
        SpeechSynthesisService.layer.pipe(
          Layer.provideMerge(
            ServerSettings.layerTest({
              speechOutput: {
                ...DEFAULT_SPEECH_OUTPUT_SETTINGS,
                elevenLabsApiKey: "voice-fixture",
              },
              cloudSpeechCredentials: { openai: "other-key" },
            }),
          ),
          Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
          Layer.provide(dependencies),
        ),
      );
      const service = Context.get(context, SpeechSynthesisService.SpeechSynthesisService);
      const settings = Context.get(context, ServerSettings.ServerSettingsService);
      const load = (token?: string) =>
        service
          .elevenLabsVoices(token)
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      const page = yield* load();
      expect(page).toEqual({
        voices: [{ id: "voice-1", name: "Faber" }],
        nextPageToken: "cursor&secret=kept",
      });
      const [address, init] = upstream.mock.calls[0]!;
      expect(String(address)).toBe("https://api.elevenlabs.io/v2/voices?page_size=100");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("xi-api-key")).toBe("voice-fixture");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("traceparent")).toBeNull();
      upstream.mockResolvedValueOnce(
        Response.json({
          voices: [{ voice_id: "voice-2", name: "George" }],
          has_more: false,
          next_page_token: null,
        }),
      );
      expect(yield* load(page.nextPageToken)).toEqual({
        voices: [{ id: "voice-2", name: "George" }],
      });
      const next = new URL(String(upstream.mock.calls[1]![0]));
      expect(next.searchParams.get("next_page_token")).toBe("cursor&secret=kept");
      expect(next.searchParams.has("secret")).toBe(false);
      for (const body of [
        { voices: [], has_more: true },
        { voices: [], has_more: true, next_page_token: "same" },
        { voices: [{ name: "No ID" }], has_more: false },
      ]) {
        upstream.mockResolvedValueOnce(Response.json(body));
        expect(yield* Effect.flip(load("same"))).toMatchObject({ reason: "unavailable" });
      }
      for (const [status, reason] of [
        [401, "rejected-key"],
        [429, "rate-limit"],
        [500, "unavailable"],
      ] as const) {
        upstream.mockResolvedValueOnce(new Response("private details", { status }));
        const error = yield* Effect.flip(load());
        expect(error).toMatchObject({ reason });
        expect(JSON.stringify(error)).not.toMatch(/private details|voice-fixture/);
      }
      const overflow = Response.json({
        voices: [],
        has_more: false,
        ignored: "x".repeat(2 * 1024 * 1024),
      });
      const source = new Uint8Array(yield* Effect.promise(() => overflow.arrayBuffer()));
      let received = 0;
      const cancelled = vi.fn();
      upstream.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                const end = Math.min(source.length, received + 600_000);
                controller.enqueue(source.subarray(received, end));
                received = end;
                if (received === source.length) controller.close();
              },
              cancel: cancelled,
            },
            { highWaterMark: 0 },
          ),
        ),
      );
      expect(yield* Effect.flip(load())).toMatchObject({ reason: "unavailable" });
      expect(cancelled).toHaveBeenCalledOnce();
      yield* settings.updateSettings({ speechOutput: { elevenLabsApiKey: "" } });
      upstream.mockClear();
      expect(yield* Effect.flip(load())).toMatchObject({ reason: "not-configured" });
      expect(upstream).not.toHaveBeenCalled();
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
