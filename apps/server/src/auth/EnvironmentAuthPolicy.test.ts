import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";

const makeEnvironmentAuthPolicyLayer = (
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
) =>
  EnvironmentAuthPolicy.layer.pipe(
    Layer.provide(ServerEnvironment.identityLayer),
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
      // Packaged desktop has no devUrl, but still needs the port scope: it
      // scans upward from 3773 for a free port and binds 127.0.0.1, so a second
      // instance shares this one's hostname on a different port.
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

  it.effect("keeps desktop cookies port-scoped on the port a second instance lands on", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.sessionCookieName).toBe("t3_session_3774");
    }).pipe(
      Effect.provide(
        makeEnvironmentAuthPolicyLayer({
          mode: "desktop",
          port: 3774,
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

  for (const host of ["127.0.0.1", "::1"]) {
    it.effect(`uses loopback-browser policy for web host ${host} without Serve`, () =>
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
            host,
            port: 3773,
            tailscaleServeEnabled: false,
          }),
        ),
      ),
    );
  }

  it.effect("uses remote-reachable policy for wildcard web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_[a-f0-9]{12}$/);
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

  for (const host of ["127.0.0.1", "::1"]) {
    it.effect(`uses remote-reachable policy for web host ${host} with Serve enabled`, () =>
      Effect.gen(function* () {
        const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
        const descriptor = yield* policy.getDescriptor();

        expect(descriptor.policy).toBe("remote-reachable");
        expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      }).pipe(
        Effect.provide(
          makeEnvironmentAuthPolicyLayer({
            mode: "web",
            host,
            tailscaleServeEnabled: true,
          }),
        ),
      ),
    );
  }

  for (const mode of ["web", "desktop"] as const) {
    it.effect(`preserves ${mode} session descriptors when Serve is enabled and disabled`, () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const descriptorForServe = (tailscaleServeEnabled: boolean) =>
          EnvironmentAuthPolicy.make.pipe(
            Effect.provideService(ServerConfig.ServerConfig, {
              ...config,
              mode,
              host: "127.0.0.1",
              port: 3773,
              tailscaleServeEnabled,
            }),
            Effect.flatMap((policy) => policy.getDescriptor()),
          );
        const disabled = yield* descriptorForServe(false);
        const enabled = yield* descriptorForServe(true);
        const disabledAgain = yield* descriptorForServe(false);

        expect(enabled).toEqual({
          ...disabled,
          policy: "remote-reachable",
          bootstrapMethods:
            mode === "desktop" ? ["desktop-bootstrap", "one-time-token"] : ["one-time-token"],
        });
        expect(enabled.sessionMethods).toEqual([
          "browser-session-cookie",
          "bearer-access-token",
          "dpop-access-token",
        ]);
        expect(disabledAgain).toEqual(disabled);
        expect(disabled.policy).toBe(
          mode === "desktop" ? "desktop-managed-local" : "loopback-browser",
        );
      }).pipe(
        Effect.provide(
          ServerEnvironment.identityLayer.pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-serve-policy-" }),
            ),
          ),
        ),
      ),
    );
  }

  it.effect("uses remote-reachable policy for non-loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_[a-f0-9]{12}$/);
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
