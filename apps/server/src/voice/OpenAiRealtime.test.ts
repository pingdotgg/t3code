import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OpenAiRealtime from "./OpenAiRealtime.ts";
import * as OpenAiRealtimeCredential from "./OpenAiRealtimeCredential.ts";

const environmentId = EnvironmentId.make("environment-voice-test");
const authSessionId = AuthSessionId.make("session-voice-test");

function makeLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) {
  const credential = OpenAiRealtimeCredential.OpenAiRealtimeCredential.of({
    status: Effect.succeed({ configured: true, source: "stored" }),
    resolve: Effect.succeed(
      Option.some({ apiKey: Redacted.make("server-api-key"), source: "stored" }),
    ),
    set: () => Effect.void,
    remove: Effect.void,
  });
  return OpenAiRealtime.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(Layer.succeed(OpenAiRealtimeCredential.OpenAiRealtimeCredential, credential)),
    Layer.provide(OpenAiRealtime.rateLimiterLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const successResponse = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientResponse.fromWeb(
    request,
    Response.json({
      value: "ek_voice_test",
      expires_at: OpenAiRealtime.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
      session: {
        type: "realtime",
        id: "sess_voice_test",
        model: "gpt-realtime-2.1",
      },
    }),
  );

it.effect("mints against the fixed OpenAI boundary with a stable safety identifier", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer((request) =>
    Effect.sync(() => {
      requests.push(request);
      return successResponse(request);
    }),
  );

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    const first = yield* realtime.mint({ authSessionId, voice: "cedar" });
    yield* realtime.mint({ authSessionId, voice: "marin" });

    assert.deepStrictEqual(first, {
      clientSecret: "ek_voice_test",
      expiresAt: OpenAiRealtime.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
      sessionId: "sess_voice_test",
    });
    assert.strictEqual(requests.length, 2);
    const request = requests[0];
    assert.ok(request);
    assert.strictEqual(request.url, OpenAiRealtime.OPENAI_REALTIME_CLIENT_SECRET_URL);
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(request.headers.authorization, "Bearer server-api-key");
    const expectedSafetyIdentifier = NodeCrypto.createHash("sha256")
      .update(`t3-realtime:${environmentId}`, "utf8")
      .digest("hex");
    assert.strictEqual(request.headers["openai-safety-identifier"], expectedSafetyIdentifier);
    assert.strictEqual(requests[1]?.headers["openai-safety-identifier"], expectedSafetyIdentifier);
    assert.strictEqual(request.body._tag, "Uint8Array");
    if (request.body._tag !== "Uint8Array") return;
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(request.body.body)), {
      expires_after: {
        anchor: "created_at",
        seconds: OpenAiRealtime.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
      },
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        audio: { output: { voice: "cedar" } },
      },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("maps upstream status without reading or exposing the response body", () => {
  let sourceResponse: Response | undefined;
  const layer = makeLayer((request) =>
    Effect.sync(() => {
      sourceResponse = Response.json(
        { error: { message: "raw-upstream-message-that-must-not-appear" } },
        { status: 401 },
      );
      return HttpClientResponse.fromWeb(request, sourceResponse);
    }),
  );

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    const error = yield* Effect.flip(realtime.mint({ authSessionId, voice: "marin" }));

    assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeUnavailableError);
    assert.strictEqual(error.reason, "credential_rejected");
    assert.isFalse(sourceResponse?.bodyUsed ?? true);
    assert.notInclude(String(error), "raw-upstream-message-that-must-not-appear");
  }).pipe(Effect.provide(layer));
});

it.effect("strictly rejects mismatched and expired client-secret responses", () => {
  const marker = "raw-invalid-response-that-must-not-appear";
  const responses = [
    {
      value: "ek_voice_test",
      expires_at: 4_102_444_800,
      session: {
        type: "transcription",
        id: "sess_voice_test",
        model: "gpt-realtime-2.1",
      },
      marker,
    },
    {
      value: "ek_voice_test",
      expires_at: 4_102_444_800,
      session: {
        type: "realtime",
        id: "sess_voice_test",
        model: "gpt-realtime",
      },
      marker,
    },
    {
      value: "ek_voice_test",
      expires_at: 1,
      session: {
        type: "realtime",
        id: "sess_voice_test",
        model: "gpt-realtime-2.1",
      },
      marker,
    },
    {
      value: "ek_voice_test",
      expires_at:
        OpenAiRealtime.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS +
        OpenAiRealtime.OPENAI_REALTIME_CLIENT_SECRET_EXPIRY_SKEW_SECONDS +
        3,
      session: {
        type: "realtime",
        id: "sess_voice_test",
        model: "gpt-realtime-2.1",
      },
      marker,
    },
  ];
  const layer = makeLayer((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, Response.json(responses.shift()))),
  );

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    yield* TestClock.adjust("2 seconds");
    yield* Effect.forEach(
      responses.map((_, index) => index),
      () =>
        Effect.flip(realtime.mint({ authSessionId, voice: "marin" })).pipe(
          Effect.tap((error) =>
            Effect.sync(() => {
              assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeUpstreamError);
              assert.strictEqual(error.reason, "invalid_response");
              assert.notInclude(String(error), marker);
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves a bounded upstream retry delay", () => {
  const layer = makeLayer((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: 429, headers: { "retry-after": "4.2" } }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    const error = yield* Effect.flip(realtime.mint({ authSessionId, voice: "marin" }));

    assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeRateLimitedError);
    assert.strictEqual(error.reason, "upstream_rate_limit");
    assert.strictEqual(error.retryAfterSeconds, 5);
  }).pipe(Effect.provide(layer));
});

it.effect("honors an upstream HTTP-date retry delay", () => {
  const layer = makeLayer((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: 429,
          headers: { "retry-after": "Tue, 11 Aug 2026 12:00:05 GMT" },
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-11T12:00:00.000Z")),
    );
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    const error = yield* Effect.flip(realtime.mint({ authSessionId, voice: "marin" }));

    assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeRateLimitedError);
    assert.strictEqual(error.reason, "upstream_rate_limit");
    assert.strictEqual(error.retryAfterSeconds, 5);
  }).pipe(Effect.provide(layer));
});

it.effect("times out after ten seconds without retrying the OpenAI request", () => {
  const execute = vi.fn((_request: HttpClientRequest.HttpClientRequest) => Effect.never);
  const layer = makeLayer(execute);

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    const fiber = yield* Effect.forkChild(realtime.mint({ authSessionId, voice: "marin" }));
    yield* TestClock.adjust(OpenAiRealtime.OPENAI_REALTIME_REQUEST_TIMEOUT);
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);

    assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeTimeoutError);
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("enforces the process-local per-session mint rate", () => {
  const layer = makeLayer((request) => Effect.succeed(successResponse(request)));

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    yield* Effect.forEach(
      Array.from({ length: OpenAiRealtime.OPENAI_REALTIME_SESSION_RATE_LIMIT }),
      () => realtime.mint({ authSessionId, voice: "marin" }),
      { discard: true },
    );
    const error = yield* Effect.flip(realtime.mint({ authSessionId, voice: "marin" }));

    assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeRateLimitedError);
    assert.strictEqual(error.reason, "local_rate_limit");
    assert.isAtLeast(error.retryAfterSeconds, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("bounds and expires distinct session rate-limit keys", () =>
  Effect.gen(function* () {
    const limiter = yield* OpenAiRealtime.makeSessionMintRateLimiter({
      limit: 1,
      maxTrackedSessions: 8,
      trackerTtl: OpenAiRealtime.OPENAI_REALTIME_SESSION_TRACKER_TTL,
    });

    yield* Effect.forEach(
      Array.from({ length: 8 }, (_, index) => AuthSessionId.make(`session-churn-${index}`)),
      limiter.consume,
      { discard: true },
    );
    assert.strictEqual(yield* limiter.trackedSessionCount, 8);

    const capacityError = yield* Effect.flip(
      limiter.consume(AuthSessionId.make("session-churn-over-capacity")),
    );
    assert.strictEqual(capacityError.reason, "local_rate_limit");
    assert.isAtLeast(capacityError.retryAfterSeconds, 1);
    assert.strictEqual(yield* limiter.trackedSessionCount, 8);

    const retainedHistoryError = yield* Effect.flip(
      limiter.consume(AuthSessionId.make("session-churn-0")),
    );
    assert.strictEqual(retainedHistoryError.reason, "local_rate_limit");

    yield* TestClock.adjust(OpenAiRealtime.OPENAI_REALTIME_SESSION_TRACKER_TTL);
    yield* limiter.consume(AuthSessionId.make("session-after-ttl"));
    assert.strictEqual(yield* limiter.trackedSessionCount, 1);
  }),
);

it.effect("retains the process-wide mint cap across distinct sessions", () => {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(successResponse(request)),
  );
  const layer = makeLayer(execute);

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    yield* Effect.forEach(
      Array.from({ length: OpenAiRealtime.OPENAI_REALTIME_GLOBAL_RATE_LIMIT }, (_, index) =>
        AuthSessionId.make(`session-global-${index}`),
      ),
      (sessionId) => realtime.mint({ authSessionId: sessionId, voice: "marin" }),
      { discard: true },
    );
    const error = yield* Effect.flip(
      realtime.mint({ authSessionId: AuthSessionId.make("session-global-over"), voice: "marin" }),
    );

    assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeRateLimitedError);
    assert.strictEqual(error.reason, "local_rate_limit");
    assert.strictEqual(execute.mock.calls.length, OpenAiRealtime.OPENAI_REALTIME_GLOBAL_RATE_LIMIT);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects excess concurrent mint requests without queuing upstream work", () =>
  Effect.gen(function* () {
    const allStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const startedCount = yield* Ref.make(0);
    const layer = makeLayer((request) =>
      Ref.updateAndGet(startedCount, (count) => count + 1).pipe(
        Effect.tap((count) =>
          count === OpenAiRealtime.OPENAI_REALTIME_MAX_CONCURRENCY
            ? Deferred.succeed(allStarted, undefined)
            : Effect.void,
        ),
        Effect.andThen(Deferred.await(release)),
        Effect.as(successResponse(request)),
      ),
    );

    yield* Effect.gen(function* () {
      const realtime = yield* OpenAiRealtime.OpenAiRealtime;
      const active = yield* Effect.forEach(
        Array.from({ length: OpenAiRealtime.OPENAI_REALTIME_MAX_CONCURRENCY }),
        () => Effect.forkChild(realtime.mint({ authSessionId, voice: "marin" })),
      );
      yield* Deferred.await(allStarted);

      const error = yield* Effect.flip(realtime.mint({ authSessionId, voice: "marin" }));
      assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeRateLimitedError);
      assert.strictEqual(error.reason, "local_concurrency");
      assert.strictEqual(
        yield* Ref.get(startedCount),
        OpenAiRealtime.OPENAI_REALTIME_MAX_CONCURRENCY,
      );

      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(active, Fiber.join, { discard: true });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("maps transport failures once without retaining authorization details", () => {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: "transport contained server-api-key",
        }),
      }),
    ),
  );
  const layer = makeLayer(execute);

  return Effect.gen(function* () {
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;
    const error = yield* Effect.flip(realtime.mint({ authSessionId, voice: "marin" }));

    assert.instanceOf(error, OpenAiRealtime.OpenAiRealtimeUpstreamError);
    assert.strictEqual(error.reason, "request_failed");
    assert.strictEqual(execute.mock.calls.length, 1);
    assert.notInclude(String(error), "server-api-key");
  }).pipe(Effect.provide(layer));
});
