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
  it.effect("exports failure types without messages or frames", () =>
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

      failure.stack = "    at connect (/home/user/private.mjs:12:34)";

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
      expect(text).not.toContain("private.mjs");
    }),
  );
});

it.effect.each([true, false])("filters relay exports at flush (%s)", (enabledAtFlush) => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  let enabled = true;
  return Effect.logWarning("private error detail").pipe(
    Effect.withSpan("relay.request", {
      attributes: {
        "url.full": "http://studio-mac.local:3773/api/threads?cursor=secret",
        "url.path": "/api/threads",
        "url.query": "cursor=secret",
        "server.address": "studio-mac.local",
        "server.port": 3773,
      },
    }),
    withRelayClientTracing,
    Effect.andThen(Effect.sync(() => (enabled = enabledAtFlush))),
    Layer.effectDiscard,
    Layer.provide(
      layer(
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
        { serviceName: "t3code-test", runtime: "node", serviceInstanceId: "id", client: "test" },
        { isEnabled: () => enabled },
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({ OTEL_RESOURCE_ATTRIBUTES: "host.name=private-host" }),
      ),
    ),
    Layer.build,
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledTimes(Number(enabledAtFlush));
        if (!enabledAtFlush) return;
        const sent = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
        expect(sent).toContain("/api/threads");
        expect(sent).not.toMatch(
          /studio-mac|cursor=secret|server\.port|private error detail|private-host/,
        );
      }),
    ),
  );
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
