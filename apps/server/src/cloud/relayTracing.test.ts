import { assert, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
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

it("tells clients when the environment or a policy opted out of relay tracing", () => {
  const policy = (telemetry: boolean) => ({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { telemetry },
  });

  assert.isTrue(allowedFor({}, undefined));
  assert.isTrue(allowedFor({}, policy(true)));
  assert.isFalse(allowedFor({}, policy(false)));
  assert.isFalse(allowedFor({ T3CODE_TELEMETRY_ENABLED: "false" }, undefined));
  assert.isFalse(allowedFor({ OTEL_SDK_DISABLED: "true" }, undefined));
});
