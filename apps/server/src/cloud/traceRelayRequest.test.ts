import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { HttpServerRequest } from "effect/http";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";

import {
  traceAuthenticatedRelayRequest,
  traceLocalHandlerWork,
  traceRelayRequest,
} from "./traceRelayRequest.ts";

const AUTHENTICATION = { startTime: 1_000n, endTime: 2_000n };

describe("relay request tracing", () => {
  it.effect("does not accept an unauthenticated request trace parent", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = [];
      const productTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://environment.example.test/api/t3-cloud/mint-credential", {
          headers: {
            traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          },
        }),
      );

      yield* traceRelayRequest(Effect.void.pipe(Effect.withSpan("relay.mint.handler"))).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
      );

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.traceId).not.toBe("0123456789abcdef0123456789abcdef");
      expect(Option.isNone(span.parent)).toBe(true);
    }),
  );

  it.effect("continues an authenticated relay trace with the product tracer", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = [];
      const productTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://environment.example.test/api/t3-cloud/mint-credential", {
          headers: {
            traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          },
        }),
      );

      yield* traceAuthenticatedRelayRequest(
        Effect.void.pipe(Effect.withSpan("relay.mint.handler")),
        AUTHENTICATION,
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
      );

      expect(spans.map((span) => span.name)).toEqual([
        "environment.relay.request",
        "EnvironmentAuth.authenticateHttpRequest",
        "relay.mint.handler",
      ]);
      const [relaySpan, authentication, handler] = spans;
      expect(Option.getOrUndefined(authentication!.parent)?.spanId).toBe(relaySpan!.spanId);
      expect(relaySpan!.traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(Option.getOrUndefined(relaySpan!.parent)?.spanId).toBe("0123456789abcdef");
      expect(Option.getOrUndefined(handler!.parent)?.spanId).toBe(relaySpan!.spanId);
    }),
  );
});

describe("relay request tracing boundary", () => {
  it.effect("exports a T3 Connect handler span but not its local work", () =>
    Effect.gen(function* () {
      const productSpans: Array<string> = [];
      const localSpans: Array<string> = [];
      const collect = (into: Array<string>) =>
        Tracer.make({
          span: (options) => {
            into.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        });
      const request = HttpServerRequest.fromWeb(
        new Request("https://environment.example.test/api/orchestration/threads/thread-1"),
      );

      // Shaped like a real handler: an Effect.fn span whose service call runs
      // on the local tracer.
      const handler = Effect.fn("environment.orchestration.threadSnapshot")(function* () {
        yield* Effect.void.pipe(
          Effect.withSpan("sql.execute"),
          Effect.withSpan("ServerSecretStore.get"),
          traceLocalHandlerWork,
        );
      });

      yield* traceAuthenticatedRelayRequest(handler(), AUTHENTICATION).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(RelayClientTracer, Option.some(collect(productSpans))),
        Effect.withTracer(collect(localSpans)),
      );

      expect(productSpans).toEqual([
        "environment.relay.request",
        "EnvironmentAuth.authenticateHttpRequest",
        "environment.orchestration.threadSnapshot",
      ]);
      expect(localSpans).toEqual(["ServerSecretStore.get", "sql.execute"]);
    }),
  );
});
