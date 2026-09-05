import { expect, it } from "vite-plus/test";
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
    error: new SpeechService.SpeechBusyError({ operation: "transcription" }),
    reason: "speech_busy",
  },
])("returns a typed client error for $reason instead of HTTP 500", async ({ error, reason }) => {
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
    const response = await handler(
      new Request("http://localhost/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(3),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request", reason });
  } finally {
    await dispose();
  }
});
