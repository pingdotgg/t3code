import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  managedTunnelStartupAction,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";

describe("managedTunnelStartupAction", () => {
  const config = {
    providerKind: "cloudflare_tunnel" as const,
    connectorToken: "connector-token",
    tunnelId: "tunnel-1",
  };

  it("requests tunnel recovery only when the relay proves it is needed", () => {
    expect(
      managedTunnelStartupAction({
        wantsCliLink: true,
        registration: { status: "recovery_required", config },
      }),
    ).toEqual({ action: "request_recovery", config });
  });

  it("creates a desired CLI link only when no local managed link exists", () => {
    expect(
      managedTunnelStartupAction({
        wantsCliLink: true,
        registration: { status: "not_linked" },
      }),
    ).toEqual({ action: "reconcile_link" });
  });

  it.each(["ready", "unavailable"] as const)(
    "does not provision after a %s registration result",
    (status) => {
      expect(
        managedTunnelStartupAction({
          wantsCliLink: true,
          registration: { status },
        }),
      ).toEqual({ action: "none" });
    },
  );
});

describe("retryManagedTunnelRegistration", () => {
  it.effect("waits for successful registration before it activates the connector", () =>
    Effect.gen(function* () {
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      let activations = 0;
      let reconciliations = 0;
      const registration = Effect.suspend(() => {
        attempts += 1;
        if (attempts === 1) {
          return Deferred.succeed(firstAttempt, undefined).pipe(
            Effect.andThen(Effect.fail("relay unavailable" as const)),
          );
        }
        return Effect.succeed({ status: "ready" as const });
      });
      const startup = retryManagedTunnelRegistration(registration, () => true).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const action = managedTunnelStartupAction({ wantsCliLink: true, registration: result });
            if (action.action === "reconcile_link") {
              reconciliations += 1;
            }
            activations += 1;
          }),
        ),
      );

      const fiber = yield* Effect.forkChild(startup, { startImmediately: true });
      yield* Deferred.await(firstAttempt);
      expect(attempts).toBe(1);
      expect(activations).toBe(0);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      expect(attempts).toBe(2);
      expect(activations).toBe(1);
      expect(reconciliations).toBe(0);
    }),
  );
});
