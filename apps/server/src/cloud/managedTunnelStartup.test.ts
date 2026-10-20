import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  MANAGED_TUNNEL_RECOVERY_COOLDOWN,
  makeManagedTunnelRecovery,
  managedTunnelStartupAction,
  nextManagedTunnelRecoveryCooldown,
  relayRetrySchedule,
  retryDesiredLinkReconcile,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";
import { RelayRequestError } from "./relayResponse.ts";

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

describe("nextManagedTunnelRecoveryCooldown", () => {
  const minutes = (value: number) => Duration.minutes(value);

  it("backs off while recoveries keep failing to fix the tunnel, up to 30 minutes", () => {
    let cooldown = MANAGED_TUNNEL_RECOVERY_COOLDOWN;
    const seen: Array<number> = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      cooldown = nextManagedTunnelRecoveryCooldown({
        current: cooldown,
        sinceLastRecovery: minutes(3),
      });
      seen.push(Duration.toMinutes(cooldown));
    }
    expect(seen).toEqual([4, 8, 16, 30, 30, 30]);
  });

  it("starts over once the previous recovery held", () => {
    expect(
      Duration.toMinutes(
        nextManagedTunnelRecoveryCooldown({ current: minutes(16), sinceLastRecovery: minutes(26) }),
      ),
    ).toBe(2);
    expect(
      Duration.toMinutes(
        nextManagedTunnelRecoveryCooldown({ current: minutes(16), sinceLastRecovery: minutes(20) }),
      ),
    ).toBe(30);
  });
});

describe("relayRetrySchedule", () => {
  it.effect("waits at least as long as the relay's Retry-After", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const request = Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new RelayRequestError({
                rejection: "unavailable",
                description: "paused",
                retryAfterMillis: 120_000,
              }),
            )
          : Effect.succeed("done");
      });
      const fiber = yield* Effect.forkChild(
        Effect.retry(request, { schedule: relayRetrySchedule }),
        {
          startImmediately: true,
        },
      );
      yield* TestClock.adjust("90 seconds");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(fiber)).toBe("done");
      expect(attempts).toBe(2);
    }),
  );
});

describe("makeManagedTunnelRecovery", () => {
  const config = {
    providerKind: "cloudflare_tunnel" as const,
    connectorToken: "connector-token",
    tunnelId: "tunnel-1",
  };

  it.effect("retries an unavailable relay every cooldown, and cools down from when it ends", () =>
    Effect.gen(function* () {
      const attemptMinutes: Array<number> = [];
      const recover = makeManagedTunnelRecovery({
        recover: () =>
          Effect.gen(function* () {
            attemptMinutes.push((yield* Clock.currentTimeMillis) / 60_000);
            return attemptMinutes.length < 4
              ? yield* Effect.fail("relay unavailable" as const)
              : true;
          }),
        isRetryable: () => true,
      });
      const run = yield* recover;
      const fiber = yield* Effect.forkChild(run(config), { startImmediately: true });
      yield* TestClock.adjust("6 minutes");
      expect(yield* Fiber.join(fiber)).toBe(true);
      expect(attemptMinutes.map(Math.round)).toEqual([0, 2, 4, 6]);

      yield* TestClock.adjust("1 minute");
      const next = yield* Effect.forkChild(run(config), { startImmediately: true });
      yield* TestClock.adjust("10 minutes");
      yield* Fiber.join(next);
      expect(attemptMinutes.map(Math.round)).toEqual([0, 2, 4, 6, 10]);
    }),
  );
});

describe("retryManagedTunnelRegistration fallback", () => {
  it.effect("falls back by the end of the window and keeps honoring Retry-After", () =>
    Effect.gen(function* () {
      let fallbackAtMillis: number | undefined;
      const attemptMillis: Array<number> = [];
      const registration = Clock.currentTimeMillis.pipe(
        Effect.tap((now) => Effect.sync(() => attemptMillis.push(now))),
        Effect.andThen(
          Effect.fail(
            new RelayRequestError({
              rejection: "unavailable",
              description: "paused",
              retryAfterMillis: 900_000,
            }),
          ),
        ),
      );
      yield* Effect.forkChild(
        retryManagedTunnelRegistration(
          registration,
          () => true,
          Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                fallbackAtMillis ??= now;
              }),
            ),
            Effect.asVoid,
          ),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("1 hour");
      expect(fallbackAtMillis).toBeDefined();
      expect(fallbackAtMillis).toBeLessThanOrEqual(10 * 60_000);
      expect(attemptMillis.length).toBeGreaterThan(2);
      for (let index = 1; index < attemptMillis.length; index++) {
        expect(attemptMillis[index]! - attemptMillis[index - 1]!).toBeGreaterThanOrEqual(900_000);
      }
    }),
  );
});

describe("retryDesiredLinkReconcile", () => {
  const relayUnavailable = new RelayRequestError({
    rejection: "unavailable",
    description: "relay unavailable",
  });

  it.effect("gives up on a local failure once the retry window ends", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let windowLogs = 0;
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          retryDesiredLinkReconcile(
            Effect.suspend(() => {
              attempts += 1;
              return Effect.fail("cloudflared cannot run" as const);
            }),
            () => true,
            () =>
              Effect.sync(() => {
                windowLogs += 1;
              }),
          ),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("2 hours");
      expect(yield* Fiber.join(fiber)).toBe("cloudflared cannot run");
      expect(attempts).toBeLessThan(20);
      expect(windowLogs).toBe(0);
    }),
  );

  it.effect("keeps relinking while the relay is down and succeeds when it returns", () =>
    Effect.gen(function* () {
      let windowLogs = 0;
      const reconcile = Effect.gen(function* () {
        return (yield* Clock.currentTimeMillis) < 30 * 60_000
          ? yield* Effect.fail(relayUnavailable)
          : "managed";
      });
      const fiber = yield* Effect.forkChild(
        retryDesiredLinkReconcile(
          reconcile,
          () => true,
          () =>
            Effect.sync(() => {
              windowLogs += 1;
            }),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("45 minutes");
      expect(yield* Fiber.join(fiber)).toBe("managed");
      expect(windowLogs).toBe(1);
    }),
  );
});
