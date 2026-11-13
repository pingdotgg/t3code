import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
  it.effect(
    "a queued request for an already replaced tunnel does not delay the next recovery",
    () =>
      Effect.gen(function* () {
        const tunnelA = {
          providerKind: "cloudflare_tunnel" as const,
          connectorToken: "token-a",
          tunnelId: "tunnel-a",
        };
        const tunnelB = { ...tunnelA, connectorToken: "token-b", tunnelId: "tunnel-b" };
        let current = tunnelA;
        const recovered: Array<string | undefined> = [];
        // Mirrors CloudLink.recoverManagedTunnel: a config that is no longer stored is a no-op.
        const recover = yield* makeManagedTunnelRecovery({
          recover: (config) =>
            Effect.sync(() => {
              if (config.tunnelId !== current.tunnelId) return false;
              recovered.push(config.tunnelId);
              current = config === tunnelA ? tunnelB : tunnelA;
              return true;
            }),
          isRetryable: () => false,
        });

        expect(yield* recover(tunnelA)).toBe(true);
        yield* Effect.forkChild(recover(tunnelA));
        yield* TestClock.adjust("1 minute");
        yield* Effect.forkChild(recover(tunnelB));
        // A request right after a recovery waits a doubled cooldown of 4 minutes.
        yield* TestClock.adjust("3 minutes");

        expect(recovered).toEqual(["tunnel-a", "tunnel-b"]);
      }),
  );
});
