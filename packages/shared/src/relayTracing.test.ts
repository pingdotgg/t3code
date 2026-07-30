import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";

import {
  makeRelayClientTracingLayer,
  RelayClientTracer,
  withRelayClientTracing,
} from "./relayTracing.ts";

function collectingTracer(spans: Array<string>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push(span.name);
      };
      return span;
    },
  });
}

describe("withRelayClientTracing", () => {
  it.effect("uses the product tracer only for relay operations", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const userTracer = collectingTracer(userSpans);
      const productTracer = collectingTracer(productSpans);

      yield* Effect.void.pipe(Effect.withSpan("user.operation"), Effect.withTracer(userTracer));
      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
        Effect.withTracer(userTracer),
      );

      expect(userSpans).toEqual(["user.operation"]);
      expect(productSpans).toEqual(["relay.operation"]);
    }),
  );

  it.effect("preserves the active tracer when product tracing is disabled", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const userTracer = collectingTracer(userSpans);

      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.withTracer(userTracer),
      );

      expect(userSpans).toEqual(["relay.operation"]);
    }),
  );

  it.effect("preserves nested error causes in exported relay spans", () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const httpClientLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    );
    const tracingLayer = makeRelayClientTracingLayer(
      {
        tracesUrl: "https://api.axiom.test/v1/traces",
        tracesDataset: "relay-traces",
        tracesToken: "public-ingest-token",
      },
      {
        serviceName: "relay-test",
        runtime: "test",
        client: "test",
      },
    ).pipe(Layer.provide(httpClientLayer));
    const rootCause = new Error("relay socket closed");
    const failure = new Error("relay request failed", { cause: rootCause });
    const tracedApplication = Layer.effectDiscard(
      Effect.fail(failure).pipe(
        Effect.withSpan("relay.failed-operation"),
        withRelayClientTracing,
        Effect.exit,
      ),
    ).pipe(Layer.provide(tracingLayer));

    return Layer.build(tracedApplication).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          expect(fetchFn).toHaveBeenCalledOnce();
          const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
          expect(payload).toContain("relay request failed");
          expect(payload).toContain("relay socket closed");
        }),
      ),
    );
  });
});
