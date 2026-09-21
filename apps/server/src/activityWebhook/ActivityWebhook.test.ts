import {
  EventId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ActivityWebhook from "./ActivityWebhook.ts";

const NOW = "2026-09-18T12:00:00.000Z";
const URL_VALUE = "https://wake.example.test/hooks/activity";
const TOKEN = "super-secret-webhook-token-value";

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: { source: string; activeThreads: number; sentAt: string };
}

const decodeBody = (body: HttpBody.HttpBody): RecordedRequest["body"] => {
  assert.strictEqual(body._tag, "Uint8Array");
  return JSON.parse(new TextDecoder().decode((body as HttpBody.Uint8Array).body));
};

// Provided around each test so fibers the service forks inherit the capture.
const logs: Array<string> = [];
const CaptureLogger = Logger.layer(
  [
    Logger.make(({ fiber, message }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      logs.push(JSON.stringify([message, annotations]));
    }),
  ],
  { mergeWithExisting: false },
);

const makeHarness = Effect.fn("makeActivityWebhookHarness")(function* (options: {
  readonly env: Record<string, string>;
  readonly status?: number;
  readonly hang?: boolean;
}) {
  logs.length = 0;
  const requests = yield* Queue.unbounded<RecordedRequest>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  const httpClient = HttpClient.make((request) =>
    Queue.offer(requests, {
      url: request.url,
      authorization: request.headers["authorization"],
      contentType:
        request.headers["content-type"] ??
        (request.body._tag === "Uint8Array" ? request.body.contentType : undefined),
      body: decodeBody(request.body),
    }).pipe(
      Effect.andThen(options.hang ? Effect.never : Effect.void),
      Effect.as(
        HttpClientResponse.fromWeb(request, new Response(null, { status: options.status ?? 204 })),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: PubSub.subscribe(domainEvents).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env })),
    FileSystem.layerNoop({}),
  );
  const service = yield* ActivityWebhook.make.pipe(Effect.provide(dependencies));
  return {
    service,
    requests,
    logs,
    publish: (event: OrchestrationEvent) => PubSub.publish(domainEvents, event),
    layer: dependencies,
  };
});

let sequence = 0;
function sessionEvent(threadId: string, status: OrchestrationSessionStatus): OrchestrationEvent {
  const id = ThreadId.make(threadId);
  const session: OrchestrationSession = {
    threadId: id,
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`evt-${sequence}`),
    aggregateKind: "thread",
    aggregateId: id,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: { threadId: id, session },
  };
}

function activityEvent(threadId: string, kind: string, requestId: string): OrchestrationEvent {
  const id = ThreadId.make(threadId);
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`evt-${sequence}`),
    aggregateKind: "thread",
    aggregateId: id,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId: id,
      activity: {
        id: EventId.make(`activity-${sequence}`),
        tone: "info",
        kind,
        summary: kind,
        payload: { requestId },
        turnId: null,
        createdAt: NOW,
      },
    },
  };
}

const ENABLED_ENV = {
  T3CODE_ACTIVITY_WEBHOOK_URL: URL_VALUE,
  T3CODE_ACTIVITY_WEBHOOK_TOKEN: TOKEN,
  T3CODE_ACTIVITY_WEBHOOK_INTERVAL_MS: "60000",
};

describe("ActivityWebhook", () => {
  it.effect("is a no-op without a URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ env: {} });
        yield* harness.service.start();
        yield* harness.service.observe(sessionEvent("t1", "running"));
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);
        assert.deepStrictEqual(
          harness.logs.filter((line) => line.includes("Activity webhook disabled")),
          [],
        );
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("disables with a warning when the token is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          env: { T3CODE_ACTIVITY_WEBHOOK_URL: URL_VALUE },
        });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);
        const warning = harness.logs.find((line) => line.includes("TOKEN is required"));
        assert.isDefined(warning);
        assert.isFalse(harness.logs.some((line) => line.includes(TOKEN)));
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("rejects plain http for non-loopback hosts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          env: { ...ENABLED_ENV, T3CODE_ACTIVITY_WEBHOOK_URL: "http://wake.example.test/activity" },
        });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);
        assert.isTrue(harness.logs.some((line) => line.includes("must be https")));
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("accepts plain http on loopback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          env: { ...ENABLED_ENV, T3CODE_ACTIVITY_WEBHOOK_URL: "http://127.0.0.1:8787/activity" },
        });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        const request = yield* Queue.take(harness.requests);
        assert.strictEqual(request.url, "http://127.0.0.1:8787/activity");
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("falls back to the default interval when the configured one is invalid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          env: { ...ENABLED_ENV, T3CODE_ACTIVITY_WEBHOOK_INTERVAL_MS: "10" },
        });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        yield* Queue.take(harness.requests);
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(harness.requests);
        assert.isTrue(harness.logs.some((line) => line.includes("INTERVAL_MS")));
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("heartbeats from the engine stream while a session runs and stops when it ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({ env: ENABLED_ENV });
        yield* harness.service.start();

        yield* harness.publish(sessionEvent("t1", "starting"));
        const first = yield* Queue.take(harness.requests);
        assert.strictEqual(first.url, URL_VALUE);
        assert.strictEqual(first.authorization, `Bearer ${TOKEN}`);
        assert.strictEqual(first.contentType, "application/json");
        assert.deepStrictEqual(first.body, { source: "t3code", activeThreads: 1, sentAt: NOW });

        yield* TestClock.adjust("60 seconds");
        yield* Queue.take(harness.requests);

        yield* harness.service.observe(sessionEvent("t1", "ready"));
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);
        assert.strictEqual((yield* harness.service.activeThreadIds).size, 0);
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("bounds each attempt so a hung endpoint cannot stall the tick", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ env: ENABLED_ENV, hang: true });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        // First attempt plus two retries, each bounded by the 10s timeout and
        // separated by 1s and 2s of backoff.
        yield* TestClock.adjust("40 seconds");
        const warning = harness.logs.find((line) => line.includes("heartbeat failed"));
        assert.isDefined(warning);
        assert.isTrue(warning!.includes("Timeout"));
        assert.isFalse(harness.logs.some((line) => line.includes(TOKEN)));
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("shares one loop across threads and stops only when the last one finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ env: ENABLED_ENV });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        yield* Queue.take(harness.requests);
        yield* harness.service.observe(sessionEvent("t2", "running"));
        assert.strictEqual(yield* Queue.size(harness.requests), 0);

        yield* TestClock.adjust("60 seconds");
        const tick = yield* Queue.take(harness.requests);
        assert.strictEqual(tick.body.activeThreads, 2);

        yield* harness.service.observe(sessionEvent("t1", "ready"));
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual((yield* Queue.take(harness.requests)).body.activeThreads, 1);

        yield* harness.service.observe(sessionEvent("t2", "stopped"));
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("retries a failed heartbeat three times with backoff and never logs the token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ env: ENABLED_ENV, status: 503 });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        yield* Queue.take(harness.requests);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(harness.requests);
        yield* TestClock.adjust("2 seconds");
        yield* Queue.take(harness.requests);
        // A fourth attempt would land 4s later; the tick gives up instead.
        yield* TestClock.adjust("3 seconds");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);
        // The next tick's request proves the failure path (and its log) finished.
        yield* TestClock.adjust("60 seconds");
        yield* Queue.take(harness.requests);

        const warning = harness.logs.find((line) => line.includes("heartbeat failed"));
        assert.isDefined(warning);
        assert.isTrue(warning.includes("wake.example.test"));
        assert.isTrue(warning.includes("503"));
        assert.isFalse(harness.logs.some((line) => line.includes(TOKEN)));

        yield* harness.service.observe(sessionEvent("t1", "ready"));
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );

  it.effect("does not treat a thread blocked on approval or user input as active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ env: ENABLED_ENV });
        yield* harness.service.observe(sessionEvent("t1", "running"));
        yield* Queue.take(harness.requests);

        yield* harness.service.observe(activityEvent("t1", "approval.requested", "req-1"));
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);

        yield* harness.service.observe(activityEvent("t1", "approval.resolved", "req-1"));
        yield* Queue.take(harness.requests);

        yield* harness.service.observe(activityEvent("t1", "user-input.requested", "req-2"));
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(yield* Queue.size(harness.requests), 0);

        yield* harness.service.observe(activityEvent("t1", "user-input.resolved", "req-2"));
        yield* Queue.take(harness.requests);
        yield* harness.service.observe(sessionEvent("t1", "ready"));
      }),
    ).pipe(Effect.provide(CaptureLogger)),
  );
});
