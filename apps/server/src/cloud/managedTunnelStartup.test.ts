import { describe, expect, it } from "@effect/vitest";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  makeManagedTunnelRecovery,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";

describe("retryManagedTunnelRegistration", () => {
  it.effect("does not fall back or retry when registration is permanently rejected", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let fallbacks = 0;
      const error = yield* Effect.flip(
        retryManagedTunnelRegistration(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("not authorized");
          }),
          () => false,
          Effect.sync(() => {
            fallbacks += 1;
          }),
        ),
      );
      expect(error).toBe("not authorized");
      expect(attempts).toBe(1);
      expect(fallbacks).toBe(0);
    }),
  );
});

describe("makeManagedTunnelRecovery", () => {
  it.effect("drops a request for a replaced tunnel without waiting a cooldown or counting it", () =>
    Effect.gen(function* () {
      const tunnel = (tunnelId: string): RelayManagedEndpointRuntimeConfig => ({
        providerKind: "cloudflare_tunnel",
        connectorToken: `token-${tunnelId}`,
        tunnelId,
      });
      const replacements: Record<string, string> = { a: "b", b: "c" };
      let stored = tunnel("a");
      const recoveredTunnels: Array<string | undefined> = [];
      // Like CloudLink.recoverManagedTunnel: a config that is no longer stored is a no-op.
      const recover = yield* makeManagedTunnelRecovery({
        recover: (config: RelayManagedEndpointRuntimeConfig) =>
          Effect.sync(() => {
            if (config.tunnelId !== stored.tunnelId) return false;
            recoveredTunnels.push(config.tunnelId);
            stored = tunnel(replacements[config.tunnelId!]!);
            return true;
          }),
        isCurrent: (config: RelayManagedEndpointRuntimeConfig) =>
          Effect.sync(() => config.tunnelId === stored.tunnelId),
        isRetryable: () => false,
      });

      yield* recover(tunnel("a"));
      expect(recoveredTunnels).toEqual(["a"]);

      // The watchers asked about tunnel a again while its recovery ran, then b failed too.
      yield* recover(tunnel("a")).pipe(Effect.andThen(recover(tunnel("b"))), Effect.forkChild);

      // b follows one real recovery, so it waits one doubled cooldown, not two.
      yield* TestClock.adjust(Duration.minutes(3));
      expect(recoveredTunnels).toEqual(["a"]);
      yield* TestClock.adjust(Duration.minutes(1));
      expect(recoveredTunnels).toEqual(["a", "b"]);
    }),
  );

  it.effect("retries a failed current-tunnel check instead of dropping the request", () =>
    Effect.gen(function* () {
      const config: RelayManagedEndpointRuntimeConfig = {
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-a",
        tunnelId: "a",
      };
      let checks = 0;
      const recover = yield* makeManagedTunnelRecovery({
        recover: () => Effect.succeed(true),
        isCurrent: () =>
          Effect.suspend(() => {
            checks += 1;
            return checks === 1 ? Effect.fail("secret read failed") : Effect.succeed(true);
          }),
        isRetryable: () => true,
      });

      const recovery = yield* recover(config).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* Fiber.join(recovery)).toBe(true);
      expect(checks).toBe(2);
    }),
  );
});
