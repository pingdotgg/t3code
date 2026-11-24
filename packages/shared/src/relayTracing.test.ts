import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import {
  layer,
  nonInterferingTracer,
  RelayClientTracer,
  withLocalTracing,
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
});

describe("nonInterferingTracer", () => {
  it.effect("exports failures without their messages", () =>
    Effect.gen(function* () {
      const exits: Array<Exit.Exit<unknown, unknown>> = [];
      const delegate = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            exits.push(exit);
          };
          return span;
        },
      });
      const failure = Object.assign(
        new Error("studio-mac could not establish a WebSocket connection.", {
          cause: new Error("connect ECONNREFUSED studio-mac.local"),
        }),
        { name: "ConnectionTransientError" },
      );

      yield* Effect.fail(failure).pipe(
        Effect.withSpan("relay.connection.attempt"),
        Effect.withTracer(nonInterferingTracer(delegate)),
        Effect.ignore,
      );

      const exit = exits[0];
      if (exit === undefined || !Exit.isFailure(exit)) throw new Error("expected a failed span");
      const exported = Cause.prettyErrors(exit.cause);
      expect(exported.map((error) => error.name)).toEqual(["ConnectionTransientError"]);
      const text = exported.map((error) => `${error.message}\n${error.stack}`).join("\n");
      expect(text).toContain("Caused by: Error");
      expect(text).not.toContain("studio-mac");
      // Frames keep their file and position, without the directory it was installed in.
      expect(text).toContain("relayTracing.test.ts:");
      expect(text).not.toMatch(/[\\/]/);
    }),
  );

  it.effect("exports a request without the machine it went to, and no log lines", () =>
    Effect.gen(function* () {
      const exported: Array<Tracer.NativeSpan> = [];
      const delegate = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          exported.push(span);
          return span;
        },
      });

      yield* Effect.logWarning("studio-mac did not answer").pipe(
        Effect.annotateLogs({ "environment.label": "studio-mac" }),
        Effect.withSpan("http.client GET", {
          attributes: {
            "http.request.method": "GET",
            "url.full": "http://studio-mac.tail1234.ts.net:3773/api/threads/t1/history?cursor=c1",
            "url.path": "/api/threads/t1/history",
            "url.query": "cursor=c1",
            "server.address": "studio-mac.tail1234.ts.net",
            "server.port": 3773,
          },
        }),
        Effect.withTracer(nonInterferingTracer(delegate)),
      );

      expect(Object.fromEntries(exported[0]?.attributes ?? [])).toEqual({
        "http.request.method": "GET",
        "url.path": "/api/threads/t1/history",
      });
      expect(exported[0]?.events).toEqual([]);
    }),
  );
});

describe("layer", () => {
  it.effect("leaves out resource attributes the operator set for their own receiver", () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    return Effect.void.pipe(
      Effect.withSpan("relay.operation"),
      withRelayClientTracing,
      Layer.effectDiscard,
      Layer.provide(
        layer(
          { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
          { serviceName: "t3code-server", runtime: "node", serviceInstanceId: "id", client: "cli" },
        ),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({ OTEL_RESOURCE_ATTRIBUTES: "host.name=studio-mac" }),
        ),
      ),
      Layer.build,
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          const sent = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
          expect(sent).toContain("relay.operation");
          expect(sent).not.toContain("studio-mac");
        }),
      ),
    );
  });
});

describe("withLocalTracing", () => {
  it.effect("keeps local work inside a relay span off the product tracer", () =>
    Effect.gen(function* () {
      const localSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const localTracer = collectingTracer(localSpans);
      const productTracer = collectingTracer(productSpans);

      yield* Effect.void.pipe(
        Effect.withSpan("relay.connection.nested"),
        Effect.andThen(
          Effect.void.pipe(
            Effect.withSpan("sql.execute"),
            Effect.withSpan("ServerSecretStore.get"),
            withLocalTracing,
          ),
        ),
        Effect.withSpan("environment.orchestration.threadSnapshot"),
        withRelayClientTracing,
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
        Effect.withTracer(localTracer),
      );

      expect(productSpans).toEqual([
        "relay.connection.nested",
        "environment.orchestration.threadSnapshot",
      ]);
      expect(localSpans).toEqual(["sql.execute", "ServerSecretStore.get"]);
    }),
  );
});
