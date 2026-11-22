import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { OtlpSerialization } from "effect/observability";
import type * as OtlpTracer from "effect/observability/OtlpTracer";

import * as ServerTraceExporter from "./ServerTraceExporter.ts";

const options = {
  url: "http://localhost:4318/v1/traces",
  exportInterval: "1 second",
  resource: { serviceName: "t3-test" },
} as const;

const sender = (client: HttpClient.HttpClient) =>
  ServerTraceExporter.make(options).pipe(
    Effect.provide(
      Layer.mergeAll(OtlpSerialization.layerJson, Layer.succeed(HttpClient.HttpClient, client)),
    ),
  );

const emit = (name: string) => Effect.void.pipe(Effect.withSpan(name, { root: true }));

it.effect("limits pending trace spans and serializes exports while a collector is slow", () =>
  Effect.gen(function* () {
    const firstResponse = yield* Deferred.make<void>();
    const batches: Array<ReadonlyArray<string>> = [];
    const tracer = yield* sender(
      HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
          const payload = JSON.parse(
            new TextDecoder().decode(request.body.body),
          ) as OtlpTracer.TraceData;
          batches.push(
            payload.resourceSpans.flatMap((resource) =>
              resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
            ),
          );
          if (batches.length === 1) yield* Deferred.await(firstResponse);
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
        }),
      ),
    );

    yield* Effect.addFinalizer(() => Deferred.succeed(firstResponse, undefined));
    yield* emit("first").pipe(Effect.withTracer(tracer));
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(batches, [["first"]]);
    yield* Effect.forEach(
      Array.from({ length: 2_500 }, (_, index) => index),
      (index) => emit(index < 1_000 ? "pending" : "overflow"),
      { discard: true },
    ).pipe(Effect.withTracer(tracer));
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(batches, [["first"]]);

    yield* Deferred.succeed(firstResponse, undefined);
    yield* TestClock.adjust("1 second");
    assert.lengthOf(batches, 2);
    assert.lengthOf(batches[1]!, 1_000);
    assert.isTrue(batches[1]!.every((name) => name === "pending"));

    yield* emit("after").pipe(Effect.withTracer(tracer));
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(batches[2], ["after"]);
  }),
);

it.effect("aborts an unresponsive trace export and sends later spans", () =>
  Effect.gen(function* () {
    const firstAborted = yield* Deferred.make<void>();
    const firstResponse = yield* Deferred.make<void>();
    let requests = 0;
    const tracer = yield* sender(
      HttpClient.make((request) =>
        Effect.suspend(() => {
          requests++;
          const response = HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
          return requests === 1
            ? Deferred.await(firstResponse).pipe(
                Effect.onInterrupt(() => Deferred.succeed(firstAborted, undefined)),
                Effect.as(response),
              )
            : Effect.succeed(response);
        }),
      ),
    );

    yield* Effect.addFinalizer(() => Deferred.succeed(firstResponse, undefined));
    yield* emit("stalled").pipe(Effect.withTracer(tracer));
    yield* TestClock.adjust("1 second");
    assert.strictEqual(requests, 1);
    yield* TestClock.adjust("10 seconds");
    assert.isTrue(yield* Deferred.isDone(firstAborted));

    // The Effect exporter skips retrying a failed collector for one minute.
    yield* TestClock.adjust("1 minute");
    yield* emit("recovered").pipe(Effect.withTracer(tracer));
    yield* TestClock.adjust("1 second");
    assert.strictEqual(requests, 2);
  }),
);

it.effect("flushes pending spans when the exporter scope closes", () =>
  Effect.gen(function* () {
    let requests = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tracer = yield* sender(
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests++;
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
            }),
          ),
        );
        yield* emit("pending").pipe(Effect.withTracer(tracer));
        assert.strictEqual(requests, 0);
      }),
    );
    assert.strictEqual(requests, 1);
  }),
);
