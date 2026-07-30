import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";

import { makeTracingLayer } from "./tracing";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

it.effect("exports spans through the scoped mobile OTLP layer", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const tracingLayer = makeTracingLayer(
    {
      tracesUrl: "https://api.axiom.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant: "test",
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(remoteHttpClientLayer(fetchFn as typeof globalThis.fetch)));
  const tracedApplication = Layer.effectDiscard(
    Effect.void.pipe(Effect.withSpan("mobile.test.span"), withRelayClientTracing),
  ).pipe(Layer.provide(tracingLayer));

  return Effect.gen(function* () {
    yield* Layer.build(tracedApplication);

    expect(fetchFn).not.toHaveBeenCalled();
  }).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledOnce();
        const [url, init] = fetchFn.mock.calls[0]!;
        expect(String(url)).toBe("https://api.axiom.test/v1/traces");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer public-ingest-token");
        expect(new Headers(init?.headers).get("x-axiom-dataset")).toBe("mobile-traces");
        expect(new TextDecoder().decode(init?.body as Uint8Array)).toContain("mobile.test.span");
      }),
    ),
  );
});

it.effect("does not let OTLP serialization failures alter application effects", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const tracingLayer = makeTracingLayer(
    {
      tracesUrl: "https://api.axiom.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant: "test",
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(remoteHttpClientLayer(fetchFn as typeof globalThis.fetch)));
  const failure = { durationNanos: 1n };
  const tracedApplication = Layer.effectDiscard(
    Effect.fail(failure).pipe(
      Effect.withSpan("mobile.test.failed-span"),
      withRelayClientTracing,
      Effect.exit,
      Effect.flatMap((exit) => {
        const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined;
        return reason && Cause.isFailReason(reason)
          ? Effect.sync(() => {
              expect(reason.error).toBe(failure);
            })
          : Effect.die(new Error("Expected the original typed failure."));
      }),
    ),
  ).pipe(Layer.provide(tracingLayer));

  return Layer.build(tracedApplication).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array)).toContain(
          "mobile.test.failed-span",
        );
      }),
    ),
  );
});
