import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";

const makeEnvironmentAuthPolicyLayer = (
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
) =>
  EnvironmentAuthPolicy.layer.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            ...overrides,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-policy-test-" })),
      ),
    ),
  );

it.layer(NodeServices.layer)("EnvironmentAuthPolicy.layer", (it) => {
  it.effect("uses desktop-managed-local policy for desktop mode", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("desktop-managed-local");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap"]);
      expect(descriptor.sessionCookieName).toBe("t3_session_3773");
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthPolicyLayer({
          mode: "desktop",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for desktop mode when bound beyond loopback", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthPolicyLayer({
          mode: "desktop",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("uses loopback-browser policy for loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("loopback-browser");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_3773_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthPolicyLayer({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for wildcard web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.sessionCookieName).toBe("t3_session");
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthPolicyLayer({
          mode: "web",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("isolates wildcard-bound web development sessions", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthPolicyLayer({
          mode: "web",
          host: "0.0.0.0",
          port: 5775,
          devUrl: new URL("http://127.0.0.1:5736"),
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for non-loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.sessionCookieName).toBe("t3_session");
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthPolicyLayer({
          mode: "web",
          host: "192.168.1.50",
        }),
      ),
    ),
  );
});
