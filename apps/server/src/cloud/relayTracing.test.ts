import { assert, it, vi } from "@effect/vitest";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import { allowedFor, relayLayer } from "./relayTracing.ts";

it("never allows relay tracing, whatever the environment says", () => {
  assert.isFalse(allowedFor({}, undefined));
  assert.isFalse(allowedFor({ T3CODE_TELEMETRY_ENABLED: "true" }, undefined));
  assert.isFalse(allowedFor({ CI: "true", T3CODE_TELEMETRY_ENABLED: "true" }, undefined));
});

it.effect("relay tracing sends nothing over the network", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  return Effect.void.pipe(
    Effect.withSpan("relay.request"),
    RelayTracing.withRelayClientTracing,
    Layer.effectDiscard,
    Layer.provide(
      relayLayer({ serviceName: "ry3code-server", runtime: "node", client: "environment-server" }),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    Layer.build,
    Effect.scoped,
    Effect.andThen(Effect.sync(() => assert.strictEqual(fetchFn.mock.calls.length, 0))),
  );
});
