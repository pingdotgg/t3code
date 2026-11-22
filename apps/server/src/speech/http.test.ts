import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - real HTTP streaming boundary test.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  CloudSpeechError,
  SpeechSynthesisError,
  EMPTY_SPEECH_SYNTHESIS_CATALOG,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SPEECH_MAX_OPTIONS_BYTES,
  SPEECH_SYNTHESIS_MAX_TEXT,
  TextGenerationError,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  type EnvironmentSpeechModel,
  EnvironmentVoiceHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as NetAddress from "effect/net/NetAddress";
import * as SpeechService from "./SpeechService.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import * as SpeechSynthesisStreams from "./synthesisStreams.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { speechHttpApiLayer } from "./http.ts";

const decodeSessionId = Schema.decodeUnknownSync(AuthSessionId);

const principal = (...scopes: AuthEnvironmentScope[]) =>
  Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: decodeSessionId("voice-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(scopes),
      }),
    ),
  );

const dependencies = Layer.mergeAll(
  Layer.mock(CloudSpeech.CloudSpeech)({}),
  Layer.mock(SpeechSynthesisStreams.SpeechSynthesisStreams)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  }),
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.TextGeneration.of({
      generateCommitMessage: () => Effect.die("not used"),
      generatePrContent: () => Effect.die("not used"),
      generateBranchName: () => Effect.die("not used"),
      generateThreadTitle: () => Effect.die("not used"),
      generateReviewGuide: () => Effect.die("not used"),
      generateTranscriptionPostProcessing: () => Effect.die("not used"),
    }),
  ),
);

effectIt.effect.each([false, true])(
  "guards speech generation and model discovery with operate scope (%s)",
  (allowed) =>
    Effect.gen(function* () {
      const start = vi.fn<SpeechSynthesisStreams.SpeechSynthesisStreams["Service"]["start"]>(() =>
        Effect.succeed("stream-token"),
      );
      const synthesisModels = vi.fn(() => Effect.succeed(EMPTY_SPEECH_SYNTHESIS_CATALOG));
      const local = { download: vi.fn(() => Effect.succeed(EMPTY_SPEECH_SYNTHESIS_CATALOG)) };
      const { handler, dispose } = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(HttpApi.make("environment").add(EnvironmentVoiceHttpApi)).pipe(
          Layer.provide(speechHttpApiLayer),
          Layer.provide(Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)(local)),
          Layer.provide(
            principal(allowed ? AuthOrchestrationOperateScope : AuthSettingsWriteScope),
          ),
          Layer.provide(Layer.mock(CloudSpeech.CloudSpeech)({ synthesisModels })),
          Layer.provide(Layer.mock(SpeechSynthesisStreams.SpeechSynthesisStreams)({ start })),
          Layer.provide(Layer.mock(SpeechService.SpeechService)({})),
          Layer.provide(dependencies),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeServices.layer),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const context = yield* Layer.build(NodeServices.layer);
      const payload = {
        text: "Hello.",
        model: "speech",
        voice: "reader",
        speed: 1,
        language: "auto",
      };
      const call = (text: string, provider = "xai") =>
        Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/voice/synthesis/${provider}/stream`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...payload, text }),
            }),
            context,
          ),
        );
      const response = yield* call(payload.text);
      const catalog = yield* Effect.promise(() =>
        handler(new Request("http://localhost/api/voice/synthesis/xai/models"), context),
      );
      expect(response.status).toBe(allowed ? 200 : 403);
      expect(catalog.status).toBe(allowed ? 200 : 403);
      // Installing a local model downloads hundreds of megabytes, so it needs settings access.
      const install = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost/api/voice/synthesis/local/models/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelId: "supertonic-3" }),
          }),
          context,
        ),
      );
      expect(install.status).toBe(allowed ? 403 : 200);
      expect(local.download).toHaveBeenCalledTimes(allowed ? 0 : 1);
      expect((yield* call(payload.text, "local")).status).toBe(allowed ? 200 : 403);
      expect(start).toHaveBeenCalledTimes(allowed ? 2 : 0);
      if (allowed) {
        expect(yield* Effect.promise(() => response.json())).toEqual({ token: "stream-token" });
        expect(start).toHaveBeenCalledWith("xai", payload);
        expect(start).toHaveBeenCalledWith("local", payload);
        expect((yield* call("a".repeat(SPEECH_SYNTHESIS_MAX_TEXT + 1))).status).toBe(400);
        expect(start).toHaveBeenCalledTimes(2);
        start.mockReturnValueOnce(
          Effect.fail(
            new SpeechSynthesisError({
              provider: "xai",
              reason: "unavailable",
              cause: new Error("private provider diagnostic"),
            }),
          ),
        );
        const failure = yield* call(payload.text);
        expect(failure.status).toBe(422);
        const body = yield* Effect.promise(() => failure.json());
        expect(body).toMatchObject({ provider: "xai", reason: "unavailable" });
        expect(body).not.toHaveProperty("cause");
        expect(JSON.stringify(body)).not.toContain("private provider diagnostic");
      } else {
        expect(synthesisModels).not.toHaveBeenCalled();
      }
    }).pipe(Effect.scoped),
);

effectIt.live("rejects oversized chunked audio without invoking transcription", () =>
  Effect.gen(function* () {
    const transcribe = vi.fn(() => Effect.succeed("unexpected"));
    const routes = HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentVoiceHttpApi),
    ).pipe(
      Layer.provide(speechHttpApiLayer),
      Layer.provide(Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({})),
      Layer.provide(principal(AuthOrchestrationOperateScope)),
      Layer.provide(
        Layer.succeed(SpeechService.SpeechService, {
          status: Effect.succeed({ supported: false as const, reason: "test" }),
          prepareModel: Effect.void,
          models: () => Effect.succeed({ models: [] }),
          downloadModel: () => Effect.succeed({ models: [], cancelled: false }),
          linkModels: () => Effect.succeed({ models: [] }),
          selectModel: () => Effect.succeed({ models: [] }),
          cancelDownload: () => Effect.succeed({ models: [] }),
          updateAcceleration: () => Effect.succeed({ supported: false as const, reason: "test" }),
          updateModelUnloadTimeout: () =>
            Effect.succeed({ supported: false as const, reason: "test" }),
          transcribe,
          startStream: () => Effect.die("not used"),
          removeModel: () => Effect.succeed({ models: [] }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
      const server = yield* HttpServer.HttpServer;
      const address = server.address as NetAddress.InetAddress;
      const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
      const url = `http://${host}:${address.port}/api/voice/transcribe`;
      const select = yield* Effect.promise(() =>
        fetch(new URL("models/select", url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelId: "test" }),
        }),
      );
      expect(select.status).toBe(403);
      const changeKey = yield* Effect.promise(() =>
        fetch(new URL("cloud/xai/key", url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "fixture" }),
        }),
      );
      expect(changeKey.status).toBe(403);
      yield* Effect.promise(() =>
        expect(
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new Uint8Array(SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 4),
                );
                controller.enqueue(new Uint8Array(4));
                controller.close();
              },
            }),
            duplex: "half",
          }),
        ).resolves.toMatchObject({ status: 413 }),
      );
      expect(transcribe).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, dependencies)));
  }),
);

effectIt.effect(
  "keeps keys write-only and returns provider failures without an auth challenge",
  () =>
    Effect.gen(function* () {
      let stored = false;
      const reference = { provider: "work", reference: "op://Work/Voice/key" };
      const save = vi.fn();
      const transcribe = vi.fn();
      const cloud = Layer.mock(CloudSpeech.CloudSpeech)({
        configured: Effect.sync(() => ({ openai: stored, xai: false })),
        models: Effect.succeed([{ id: "acme/transcribe-1", name: "Acme Transcribe" }]),
        setKey: (provider, key) =>
          Effect.sync(() => {
            save(provider, key);
            stored =
              provider === "openai" &&
              Redacted.isRedacted(key) &&
              Redacted.value(key) === "fixture";
          }),
        transcribe: (provider, _pcm, _options, model) => {
          transcribe(provider, model);
          return Effect.fail(new CloudSpeechError({ provider, reason: "rejected-key" }));
        },
      });
      const linkSynthesis = vi.fn();
      const local = Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({
        catalog: Effect.succeed({
          ...EMPTY_SPEECH_SYNTHESIS_CATALOG,
          models: [
            {
              id: "fixture-voice",
              name: "Fixture voice",
              voices: [],
              install: {
                state: "installed",
                size: 1,
                linkedFrom: "/home/someone/models/voice.gguf",
              },
            },
          ],
        }),
        link: (source) => {
          linkSynthesis(source);
          return Effect.succeed(EMPTY_SPEECH_SYNTHESIS_CATALOG);
        },
      });
      const linkedModel: EnvironmentSpeechModel = {
        id: "fixture/model",
        name: "Fixture",
        description: "",
        size: 1,
        languages: ["en"],
        accuracy: 0,
        speed: 0,
        recommended: false,
        supportsStreaming: false,
        supportsLanguageDetection: false,
        supportsTranslation: false,
        active: true,
        state: "installed",
        linkedFrom: "/home/someone/models/fixture.gguf",
      };
      const { handler, dispose } = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(HttpApi.make("environment").add(EnvironmentVoiceHttpApi)).pipe(
          Layer.provide(speechHttpApiLayer),
          Layer.provide(local),
          Layer.provide(principal(AuthOrchestrationOperateScope, AuthSettingsWriteScope)),
          Layer.provide(
            Layer.mock(SpeechService.SpeechService)({
              models: () => Effect.succeed({ models: [linkedModel] }),
              downloadModel: () => Effect.succeed({ models: [linkedModel], cancelled: true }),
            }),
          ),
          Layer.provide(cloud),
          Layer.provide(dependencies),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeServices.layer),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const context = yield* Layer.build(NodeServices.layer);
      const call = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          handler(new Request(`http://localhost/api/voice/cloud/${path}`, init), context),
        );
      const saved = yield* call("openai/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "fixture" }),
      });
      expect(saved.status).toBe(204);
      expect(yield* Effect.promise(() => saved.text())).toBe("");
      const keys = yield* call("keys");
      expect(yield* Effect.promise(() => keys.json())).toEqual({
        openai: true,
        xai: false,
      });
      const setReference = (key: unknown) =>
        call("xai/key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key }),
        });
      expect((yield* setReference(reference)).status).toBe(204);
      expect(save).toHaveBeenLastCalledWith("xai", reference);
      expect((yield* setReference(reference.reference)).status).toBe(400);
      expect(save).toHaveBeenCalledTimes(2);
      const failed = yield* call("openai/transcribe", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: encodeSpeechPcmRequest(new Uint8Array(4), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      });
      expect(failed.status).toBe(422);
      expect(yield* Effect.promise(() => failed.json())).toEqual({
        _tag: "CloudSpeechError",
        provider: "openai",
        reason: "rejected-key",
      });
      expect(transcribe).toHaveBeenLastCalledWith("openai", undefined);
      const catalog = yield* call("openrouter/models");
      expect(yield* Effect.promise(() => catalog.json())).toEqual({
        models: [{ id: "acme/transcribe-1", name: "Acme Transcribe" }],
      });
      const audio = {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: encodeSpeechPcmRequest(new Uint8Array(4), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      };
      expect((yield* call("openrouter/transcribe?model=openrouter%2Fauto", audio)).status).toBe(
        400,
      );
      expect((yield* call("openrouter/transcribe?model=acme%2Ftranscribe-1", audio)).status).toBe(
        422,
      );
      expect(transcribe).toHaveBeenLastCalledWith("openrouter", "acme/transcribe-1");
      // Naming a path on the environment needs filesystem access, not only settings access.
      for (const path of ["models/link", "synthesis/local/models/link"]) {
        const link = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/voice/${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ path: "/models" }),
            }),
            context,
          ),
        );
        expect(link.status).toBe(403);
      }
      expect(linkSynthesis).not.toHaveBeenCalled();
      for (const path of ["models", "synthesis/local/models"]) {
        const listed = yield* Effect.promise(() =>
          handler(new Request(`http://localhost/api/voice/${path}`), context),
        );
        expect(yield* Effect.promise(() => listed.text())).not.toContain("/home/someone");
      }
      const link = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost/api/voice/models/link", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/models" }),
          }),
          context,
        ),
      );
      expect(link.status).toBe(403);
      const listed = yield* Effect.promise(() =>
        handler(new Request("http://localhost/api/voice/models"), context),
      );
      expect(yield* Effect.promise(() => listed.text())).not.toContain("/home/someone");
      const downloaded = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost/api/voice/models/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelId: linkedModel.id }),
          }),
          context,
        ),
      );
      expect(downloaded.status).toBe(200);
      const { linkedFrom: _, ...publicModel } = linkedModel;
      expect(yield* Effect.promise(() => downloaded.json())).toEqual({
        models: [publicModel],
        cancelled: true,
      });
    }),
);

effectIt.effect.each([
  {
    error: new SpeechService.SpeechInvalidAudioError({ byteLength: 3, message: "invalid PCM" }),
    reason: "invalid_audio",
  },
  {
    error: new SpeechService.SpeechUnsupportedPlatformError({
      platform: "win32",
      architecture: "arm64",
    }),
    reason: "speech_unavailable",
  },
  {
    malformedOptions: true,
    error: new SpeechService.SpeechInvalidAudioError({ byteLength: 3, message: "invalid PCM" }),
    reason: "invalid_audio",
  },
  {
    oversized: true,
    error: new SpeechService.SpeechInvalidAudioError({ byteLength: 3, message: "invalid PCM" }),
    reason: "invalid_audio",
  },
  {
    error: new SpeechService.SpeechBusyError({ operation: "transcription" }),
    reason: "speech_busy",
  },
])(
  "returns a typed client error for $reason instead of HTTP 500",
  ({ error, reason, ...options }) =>
    Effect.gen(function* () {
      // Only authentication and the native service are replaced; exercise the actual HTTP handlers and codecs.
      const transcribe = vi.fn(() => Effect.fail(error));
      const service = Layer.succeed(SpeechService.SpeechService, {
        status: Effect.succeed({ supported: false as const, reason: "test" }),
        prepareModel: Effect.void,
        models: () => Effect.succeed({ models: [] }),
        downloadModel: () => Effect.fail(error),
        linkModels: () => Effect.fail(error),
        selectModel: () => Effect.fail(error),
        cancelDownload: () => Effect.fail(error),
        updateAcceleration: () => Effect.fail(error),
        updateModelUnloadTimeout: () => Effect.fail(error),
        transcribe,
        startStream: () => Effect.fail(error),
        removeModel: () => Effect.fail(error),
      });
      const api = HttpApi.make("environment").add(EnvironmentVoiceHttpApi);
      const { handler, dispose } = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(speechHttpApiLayer),
          Layer.provide(Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({})),
          Layer.provide(principal(AuthOrchestrationOperateScope)),
          Layer.provide(service),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(dependencies),
          Layer.provide(NodeServices.layer),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const request = new Request("http://localhost/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body:
          "malformedOptions" in options
            ? new Uint8Array([255, 255, 255, 255])
            : encodeSpeechPcmRequest(new Uint8Array(3), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      });
      const decode = vi.spyOn(request, "arrayBuffer");
      if ("oversized" in options)
        request.headers.set(
          "content-length",
          String(SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 5),
        );
      const context = yield* Layer.build(Layer.mergeAll(dependencies, NodeServices.layer));
      const response = yield* Effect.promise(() => handler(request, context));
      if ("oversized" in options) expect(decode).not.toHaveBeenCalled();
      if ("malformedOptions" in options || "oversized" in options) {
        expect(transcribe).not.toHaveBeenCalled();
      } else {
        expect(transcribe).toHaveBeenCalledWith(
          new Uint8Array(3),
          DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        );
      }
      expect(response.status).toBe(400);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "invalid_request",
        reason,
      });
    }),
);

effectIt.effect("tells the client why transcript cleanup failed", () =>
  Effect.gen(function* () {
    const detail = "OpenCode returned invalid structured output.";
    const failingCleanup = Layer.mergeAll(
      dependencies,
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("not used"),
          generatePrContent: () => Effect.die("not used"),
          generateBranchName: () => Effect.die("not used"),
          generateThreadTitle: () => Effect.die("not used"),
          generateReviewGuide: () => Effect.die("not used"),
          generateTranscriptionPostProcessing: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateTranscriptionPostProcessing",
                detail,
              }),
            ),
        }),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(HttpApi.make("environment").add(EnvironmentVoiceHttpApi)).pipe(
        Layer.provide(speechHttpApiLayer),
        Layer.provide(principal(AuthOrchestrationOperateScope)),
        Layer.provide(Layer.mock(SpeechService.SpeechService)({})),
        Layer.provide(Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({})),
        Layer.provide(failingCleanup),
        // Cleanup makes a real temporary directory; the HTTP services only carry a no-op filesystem.
        Layer.provide(NodeServices.layer),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const context = yield* Layer.build(Layer.mergeAll(failingCleanup, NodeServices.layer));
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://localhost/api/voice/post-process", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            options: {
              speechCustomWords: [],
              speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
            },
            transcript: "um so hello world",
            draft: { text: "", selection: { start: 0, end: 0 } },
          }),
        }),
        context,
      ),
    );
    expect(response.ok).toBe(false);
    expect(yield* Effect.promise(() => response.text())).toContain(detail);
  }),
);
