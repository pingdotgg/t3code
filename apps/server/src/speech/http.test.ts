import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - real HTTP streaming boundary test.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  CloudSpeechError,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SPEECH_MAX_OPTIONS_BYTES,
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
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { speechHttpApiLayer } from "./http.ts";

const decodeSessionId = Schema.decodeUnknownSync(AuthSessionId);

const principalWith = (scopes: ReadonlySet<AuthEnvironmentScope>) =>
  Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: decodeSessionId("voice-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes,
      }),
    ),
  );
const principal = (...scopes: AuthEnvironmentScope[]) => principalWith(new Set(scopes));

const dependencies = Layer.mergeAll(
  Layer.mock(CloudSpeech.CloudSpeech)({}),
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
      generatePromptSuggestion: () => Effect.die("not used"),
    }),
  ),
);

effectIt.live("rejects oversized chunked audio without invoking transcription", () =>
  Effect.gen(function* () {
    const transcribe = vi.fn(() => Effect.succeed("unexpected"));
    const routes = HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentVoiceHttpApi),
    ).pipe(
      Layer.provide(speechHttpApiLayer),
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
      const scopes = new Set<AuthEnvironmentScope>([
        AuthOrchestrationOperateScope,
        AuthSettingsWriteScope,
      ]);
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
          Layer.provide(principalWith(scopes)),
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
      // A reference needs the scope that saving it through settings would.
      const refused = yield* setReference(reference);
      expect(refused.status).toBe(403);
      expect(yield* Effect.promise(() => refused.json())).toMatchObject({
        requiredPermission: AuthProvidersManageScope,
      });
      expect(save).toHaveBeenCalledTimes(1);
      scopes.add(AuthProvidersManageScope);
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
          generatePromptSuggestion: () => Effect.die("not used"),
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
