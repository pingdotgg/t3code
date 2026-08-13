import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopPortForwardManager from "./DesktopPortForwardManager.ts";

it.layer(NodeServices.layer)("DesktopPortForwardManager", (it) => {
  it("preserves renderer authorization failures for the forward status", () => {
    const error = new DesktopPortForwardManager.DesktopPortForwardError({
      operation: "authorize",
      cause: "Remote environment returned 404.",
      detail: "Remote environment returned 404",
    });

    expect(error.message).toBe(
      "Desktop port forward authorize failed: Remote environment returned 404.",
    );
  });

  it.effect("atomically allocates and stops a desktop loopback listener", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const created = yield* manager.create({
        environmentId: EnvironmentId.make("environment-a"),
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });

      expect(created.localHost).toBe("127.0.0.1");
      expect(created.localPort).toBeGreaterThan(0);
      expect(yield* manager.list).toEqual([created]);

      yield* manager.stop(created.id);
      expect(yield* manager.list).toEqual([]);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );

  it.effect("stops only forwards owned by the removed environment", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const firstEnvironment = EnvironmentId.make("environment-a");
      const secondEnvironment = EnvironmentId.make("environment-b");
      yield* manager.create({
        environmentId: firstEnvironment,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });
      const retained = yield* manager.create({
        environmentId: secondEnvironment,
        remoteHost: "127.0.0.1",
        remotePort: 3001,
      });

      yield* manager.stopEnvironment(firstEnvironment);
      expect(yield* manager.list).toEqual([retained]);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );

  it.effect("reports an explicit local-port conflict without replacing the owner", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const environmentId = EnvironmentId.make("environment-a");
      const owner = yield* manager.create({
        environmentId,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });

      const conflict = yield* Effect.flip(
        manager.create({
          environmentId,
          remoteHost: "127.0.0.1",
          remotePort: 3001,
          localPort: owner.localPort,
        }),
      );
      expect(conflict._tag).toBe("DesktopPortForwardError");
      expect(yield* manager.list).toEqual([owner]);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );

  it.effect("chooses another local port when two environments prefer the same port", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const first = yield* manager.create({
        environmentId: EnvironmentId.make("environment-a"),
        remoteHost: "127.0.0.1",
        remotePort: 42000,
      });
      const second = yield* manager.create({
        environmentId: EnvironmentId.make("environment-b"),
        remoteHost: "127.0.0.1",
        remotePort: first.localPort,
      });

      expect(second.localPort).not.toBe(first.localPort);
      expect(yield* manager.list).toHaveLength(2);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );
});
