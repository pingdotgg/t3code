import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import { RelayRequestError, shouldRetryRelayRequest } from "./relayResponse.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  managedTunnelStartupAction,
  makeManagedTunnelRecovery,
  retryDesiredManagedTunnelLink,
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

  it.each(["ready", "unavailable", "revoked"] as const)(
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

  it.effect("stops retrying after the retry window so startup can fall back", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const registration = Effect.suspend(() => {
        attempts += 1;
        return Effect.fail("relay unavailable" as const);
      });
      const fiber = yield* Effect.forkChild(
        Effect.flip(retryManagedTunnelRegistration(registration, () => true)),
        { startImmediately: true },
      );
      yield* TestClock.adjust("15 minutes");
      expect(yield* Fiber.join(fiber)).toBe("relay unavailable");
      expect(attempts).toBeGreaterThan(5);
      expect(attempts).toBeLessThan(60);
    }),
  );

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

it.effect(
  "retries the first desired link beyond ten minutes until clock correction, but stops on a permanent refusal",
  () =>
    Effect.gen(function* () {
      let corrected = false;
      let attempts = 0;
      const firstAttempt = yield* Deferred.make<void>();
      const reconcile = Effect.suspend(() => {
        attempts += 1;
        return Deferred.succeed(firstAttempt, undefined).pipe(
          Effect.andThen(
            corrected
              ? Effect.succeed("managed" as const)
              : Effect.fail(
                  new RelayRequestError({
                    rejection: "unauthorized",
                    description: "clock skew",
                    clockSkewSeconds: -420,
                  }),
                ),
          ),
        );
      });
      const fiber = yield* Effect.forkChild(
        retryDesiredManagedTunnelLink(reconcile, shouldRetryRelayRequest),
        { startImmediately: true },
      );
      yield* Deferred.await(firstAttempt);
      yield* TestClock.adjust("15 minutes");
      expect(attempts).toBeGreaterThan(20);
      corrected = true;
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(fiber)).toBe("managed");
      let rejectedAttempts = 0;
      const error = yield* Effect.flip(
        retryDesiredManagedTunnelLink(
          Effect.suspend(() => {
            rejectedAttempts += 1;
            return Effect.fail(
              new RelayRequestError({ rejection: "unauthorized", description: "revoked" }),
            );
          }),
          shouldRetryRelayRequest,
        ),
      );
      expect(error.rejection).toBe("unauthorized");
      expect(rejectedAttempts).toBe(1);
    }),
);

it.effect("keeps recovery cooldowns through forward and backward wall-clock corrections", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    let wallOffset = 3_600_000;
    const wallMillis = () => clock.currentTimeMillisUnsafe() + wallOffset;
    const hostClock = {
      ...clock,
      currentTimeMillisUnsafe: wallMillis,
      currentTimeMillis: Effect.sync(wallMillis),
      currentTimeNanosUnsafe: () => BigInt(wallMillis()) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(wallMillis()) * 1_000_000n),
    };
    const config = {
      providerKind: "cloudflare_tunnel" as const,
      connectorToken: "token",
      tunnelId: "tunnel",
    };
    let attempts = 0;
    const firstAttempt = yield* Deferred.make<void>();
    const recover = yield* makeManagedTunnelRecovery(
      () =>
        Effect.gen(function* () {
          attempts += 1;
          if (attempts === 1) {
            yield* Deferred.succeed(firstAttempt, undefined);
            return yield* new RelayRequestError({
              rejection: "unauthorized",
              description: "clock skew",
              clockSkewSeconds: 3600,
            });
          }
          return true;
        }),
      shouldRetryRelayRequest,
    );
    const fiber = yield* Effect.forkChild(
      recover(config).pipe(Effect.provideService(Clock.Clock, hostClock)),
      { startImmediately: true },
    );
    yield* Deferred.await(firstAttempt);
    wallOffset = 0;
    yield* TestClock.adjust("119 seconds");
    expect(attempts).toBe(1);
    yield* TestClock.adjust("1 second");
    expect(attempts).toBe(2);
    expect(yield* Fiber.join(fiber)).toBe(true);
    wallOffset = 3_600_000;
    const next = yield* Effect.forkChild(
      recover(config).pipe(Effect.provideService(Clock.Clock, hostClock)),
      { startImmediately: true },
    );
    yield* TestClock.adjust("119 seconds");
    expect(attempts).toBe(2);
    yield* TestClock.adjust("1 second");
    expect(attempts).toBe(3);
    expect(yield* Fiber.join(next)).toBe(true);
  }),
);
