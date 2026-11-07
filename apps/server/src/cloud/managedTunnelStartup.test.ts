import { describe, expect, it } from "@effect/vitest";
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
  it.effect("skips a request for a tunnel it already replaced", () =>
    Effect.gen(function* () {
      const recovered: Array<string | undefined> = [];
      const recover = yield* makeManagedTunnelRecovery({
        recover: (config) =>
          Effect.sync(() => {
            recovered.push(config.tunnelId);
            return true;
          }),
        isRetryable: () => false,
      });
      const replaced = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token-a",
        tunnelId: "tunnel-a",
      };

      expect(yield* recover(replaced)).toBe(true);
      const stale = yield* recover({ ...replaced }).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 minutes");

      expect(yield* Fiber.join(stale)).toBe(false);
      expect(recovered).toEqual(["tunnel-a"]);
    }),
  );
});
