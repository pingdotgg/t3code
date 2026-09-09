// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - real HTTP streaming boundary test.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it as effectIt } from "@effect/vitest";
import { expect, it, vi } from "vite-plus/test";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
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
import * as SpeechService from "./SpeechService.ts";
import { speechHttpApiLayer } from "./http.ts";

const decodeSessionId = Schema.decodeUnknownSync(AuthSessionId);

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
          transcribe,
          removeModel: Effect.succeed({ supported: false as const, reason: "test" }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP server");
      const url = `http://127.0.0.1:${server.address.port}/api/voice/transcribe`;
      yield* Effect.promise(() =>
        expect(
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(SpeechService.MAX_SPEECH_BYTES));
                controller.enqueue(new Uint8Array(4));
                controller.close();
              },
            }),
            ...{ duplex: "half" },
          }),
        ).rejects.toMatchObject({ cause: { code: "UND_ERR_SOCKET" } }),
      );
      expect(transcribe).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
  }),
);

it.each([
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
  async ({ error, reason, ...options }) => {
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
    const service = Layer.succeed(SpeechService.SpeechService, {
      status: Effect.succeed({ supported: false as const, reason: "test" }),
      transcribe: () => Effect.fail(error),
      removeModel: Effect.fail(error),
    });
    const api = HttpApi.make("environment").add(EnvironmentVoiceHttpApi);
    const { handler, dispose } = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(api).pipe(
        Layer.provide(speechHttpApiLayer),
        Layer.provide(auth),
        Layer.provide(service),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
    try {
      const request = new Request("http://localhost/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(3),
      });
      const decode = vi.spyOn(request, "arrayBuffer");
      if ("oversized" in options)
        request.headers.set("content-length", String(SpeechService.MAX_SPEECH_BYTES + 1));
      const response = await handler(request);
      if ("oversized" in options) expect(decode).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request", reason });
    } finally {
      await dispose();
    }
  },
);
