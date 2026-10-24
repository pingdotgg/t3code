import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";

import * as Tracing from "./tracing";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

const exportedResourceBody = (appVariant: string) => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = Tracing.layerFromConfig(
    {
      tracesUrl: "https://api.axiom.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant,
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));
  const layerTracedApplication = Layer.effectDiscard(
    Effect.void.pipe(Effect.withSpan("mobile.test.span"), withRelayClientTracing),
  ).pipe(Layer.provide(layerTracing));

  return Layer.build(layerTracedApplication).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledOnce();
        return new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
      }),
    ),
  );
};

const stringAttribute = (key: string, value: string) =>
  `"key":"${key}","value":{"stringValue":"${value}"}`;

it.effect.each([
  ["development", "development", "dev"],
  ["preview", "staging", "preview"],
  ["production", "production", "stable"],
] as const)("reports %s builds as %s on the %s channel", ([appVariant, environment, channel]) =>
  exportedResourceBody(appVariant).pipe(
    Effect.andThen((body) =>
      Effect.sync(() => {
        expect(body).toContain(stringAttribute("deployment.environment.name", environment));
        expect(body).toContain(stringAttribute("t3code.release.channel", channel));
      }),
    ),
  ),
);

it.effect("omits environment and channel for an unknown variant", () =>
  exportedResourceBody("unknown").pipe(
    Effect.andThen((body) =>
      Effect.sync(() => {
        expect(body).not.toContain("deployment.environment.name");
        expect(body).not.toContain("t3code.release.channel");
      }),
    ),
  ),
);

it.effect("does not let OTLP serialization failures alter application effects", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = Tracing.layerFromConfig(
    {
      tracesUrl: "https://api.axiom.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant: "test",
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));
  const failure = { durationNanos: 1n };
  const layerTracedApplication = Layer.effectDiscard(
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
  ).pipe(Layer.provide(layerTracing));

  return Layer.build(layerTracedApplication).pipe(
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
