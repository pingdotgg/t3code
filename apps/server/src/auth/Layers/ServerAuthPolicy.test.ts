import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";

const makeServerAuthPolicyLayer = (overrides?: Partial<ServerConfigShape>) =>
  ServerAuthPolicyLive.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          return {
            ...config,
            ...overrides,
          } satisfies ServerConfigShape;
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-policy-test-" })),
      ),
    ),
  );

it.layer(NodeServices.layer)("ServerAuthPolicyLive", (it) => {
  it.effect("uses desktop-managed-local policy for desktop mode", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("desktop-managed-local");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "desktop",
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for desktop mode when bound beyond loopback", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "desktop",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("uses loopback-browser policy for loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("loopback-browser");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "127.0.0.1",
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for wildcard web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for non-loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "192.168.1.50",
        }),
      ),
    ),
  );
});
