import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - real HTTP streaming boundary test.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SPEECH_MAX_OPTIONS_BYTES,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentVoiceHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import type * as NetAddress from "effect/unstable/net/NetAddress";
import * as SpeechService from "./SpeechService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { speechHttpApiLayer } from "./http.ts";

const decodeSessionId = Schema.decodeUnknownSync(AuthSessionId);

const dependencies = Layer.mergeAll(
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
      generateTranscriptionPostProcessing: () => Effect.die("not used"),
    }),
  ),
);

effectIt.live("rejects oversized chunked audio without invoking transcription", () =>
  Effect.gen(function* () {
    const transcribe = vi.fn(() => Effect.succeed("unexpected"));
    const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
      effect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          sessionId: decodeSessionId("voice-test"),
          subject: "test",
          method: "bearer-access-token",
          scopes: new Set([AuthOrchestrationOperateScope]),
        }),
      ),
    );
    const routes = HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentVoiceHttpApi),
    ).pipe(
      Layer.provide(speechHttpApiLayer),
      Layer.provide(auth),
      Layer.provide(
        Layer.succeed(SpeechService.SpeechService, {
          status: Effect.succeed({ supported: false as const, reason: "test" }),
          prepareModel: Effect.void,
          models: Effect.succeed({ models: [] }),
          downloadModel: () => Effect.succeed({ models: [] }),
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
        ).rejects.toMatchObject({ cause: { code: "UND_ERR_SOCKET" } }),
      );
      expect(transcribe).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, dependencies)));
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
      const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
        effect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            sessionId: decodeSessionId("voice-test"),
            subject: "test",
            method: "bearer-access-token",
            scopes: new Set([AuthOrchestrationOperateScope]),
          }),
        ),
      );
      const transcribe = vi.fn(() => Effect.fail(error));
      const service = Layer.succeed(SpeechService.SpeechService, {
        status: Effect.succeed({ supported: false as const, reason: "test" }),
        prepareModel: Effect.void,
        models: Effect.succeed({ models: [] }),
        downloadModel: () => Effect.fail(error),
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
          Layer.provide(auth),
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
    }).pipe(Effect.scoped),
);
