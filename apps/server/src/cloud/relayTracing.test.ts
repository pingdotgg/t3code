import { assert, it, vi } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { allowedFor, relayLayer } from "./relayTracing.ts";

const tracesTo = (policy?: ManagedPolicyDocument) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
      ).pipe(Layer.provide(ManagedPolicy.layerTest(policy)), Layer.provide(FetchHttpClient.layer)),
    ),
    Effect.map(Option.isSome),
  );

it.effect("a policy with telemetry off stops relay tracing to T3 Connect", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* tracesTo());
    assert.isFalse(
      yield* tracesTo({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      }),
    );
  }),
);

it.effect("relay tracing waits for the desktop shell's telemetry opt-out", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const environment: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
  return Effect.void.pipe(
    Effect.withSpan("relay.request"),
    RelayTracing.withRelayClientTracing,
    Effect.andThen(
      Effect.sync(() => {
        assert.isFalse(allowedFor(environment, undefined));
        // What desktop shell discovery does once ~/.zshrc turns telemetry off.
        environment.T3CODE_TELEMETRY_ENABLED = "false";
        delete environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
      }),
    ),
    Layer.effectDiscard,
    Layer.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
      ),
    ),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    Layer.build,
    Effect.scoped,
    Effect.andThen(Effect.sync(() => assert.strictEqual(fetchFn.mock.calls.length, 0))),
  );
});

it("reports the server's relay tracing policy to clients", () => {
  assert.isTrue(allowedFor({}, undefined));
  assert.isFalse(allowedFor({ T3CODE_TELEMETRY_ENABLED: "false" }, undefined));
  assert.isFalse(allowedFor({ CI: "true" }, undefined));
  assert.isTrue(allowedFor({ CI: "true", T3CODE_TELEMETRY_ENABLED: "true" }, undefined));
  assert.isFalse(
    allowedFor(
      { T3CODE_TELEMETRY_ENABLED: "true" },
      { organization: "Example Corp", lockedSettings: [], limits: { telemetry: false } },
    ),
  );
});
