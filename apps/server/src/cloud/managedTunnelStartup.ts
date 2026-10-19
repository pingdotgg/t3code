import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Semaphore from "effect/Semaphore";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { isRelayClockSkewError } from "./relayResponse.ts";

// "revoked" leads to no action: relinking a deregistered environment is the
// user's call, so startup neither retries nor relinks it.
export type ManagedTunnelRegistrationResult =
  | { readonly status: "not_linked" | "ready" | "unavailable" | "superseded" | "revoked" }
  | {
      readonly status: "recovery_required";
      readonly config: RelayManagedEndpointRuntimeConfig;
    };

export type ManagedTunnelStartupAction =
  | { readonly action: "none" }
  | { readonly action: "reconcile_link" }
  | {
      readonly action: "request_recovery";
      readonly config: RelayManagedEndpointRuntimeConfig;
    };

export function managedTunnelStartupAction(input: {
  readonly wantsCliLink: boolean;
  readonly registration: ManagedTunnelRegistrationResult;
}): ManagedTunnelStartupAction {
  if (input.registration.status === "recovery_required") {
    return {
      action: "request_recovery",
      config: input.registration.config,
    };
  }
  if (input.wantsCliLink && input.registration.status === "not_linked") {
    return { action: "reconcile_link" };
  }
  return { action: "none" };
}

const MANAGED_TUNNEL_REGISTRATION_RETRY_WINDOW = Duration.minutes(10);

export const retryManagedTunnelRegistration = <A, E, R>(
  registration: Effect.Effect<A, E, R>,
  isRetryable: (error: E) => boolean,
  onRetryWindowExhausted?: Effect.Effect<void, never, R>,
) => {
  const schedule = Schedule.exponential("1 second").pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
    Schedule.jittered,
  );
  const withinWindow = registration.pipe(
    Effect.retry({
      while: isRetryable,
      schedule: schedule.pipe(
        Schedule.upTo({ duration: MANAGED_TUNNEL_REGISTRATION_RETRY_WINDOW }),
      ),
    }),
  );
  if (onRetryWindowExhausted === undefined) return withinWindow;
  return withinWindow.pipe(
    Effect.catchIf(isRetryable, () =>
      onRetryWindowExhausted.pipe(
        Effect.andThen(registration.pipe(Effect.retry({ while: isRetryable, schedule }))),
      ),
    ),
  );
};

// Every managed host shares one relay, so a host stuck in a bad loop must not
// turn into a fleet-wide request storm.
const MANAGED_TUNNEL_RECOVERY_COOLDOWN = Duration.minutes(2);

// Existing hosts register on their first boot after an upgrade, and desktop
// auto-update delivers that boot to many hosts at once. Spread the first
// registration so the relay and Cloudflare see a ramp instead of a spike.
export const MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER = Duration.seconds(30);

export const retryDesiredManagedTunnelLink = <A, E, R>(
  reconcile: Effect.Effect<A, E, R>,
  isRetryable: (error: E) => boolean,
) =>
  reconcile.pipe(
    Effect.retry({ while: isRelayClockSkewError, schedule: Schedule.spaced("30 seconds") }),
    Effect.retry({
      while: isRetryable,
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
        ),
        Schedule.upTo({ duration: "10 minutes" }),
      ),
    }),
  );

export const makeManagedTunnelRecovery = Effect.fnUntraced(function* <A, E, R>(
  recover: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<A, E, R>,
  isRetryable: (error: E) => boolean,
) {
  const lock = yield* Semaphore.make(1);
  let lastAttemptNanos: bigint | null = null;
  return (config: RelayManagedEndpointRuntimeConfig) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        // Clock corrections must neither bypass nor extend the relay cooldown.
        const now = yield* Clock.monotonicTimeNanos;
        if (lastAttemptNanos !== null) {
          const elapsedMillis = Number(now - lastAttemptNanos) / 1_000_000;
          const wait = Duration.toMillis(MANAGED_TUNNEL_RECOVERY_COOLDOWN) - elapsedMillis;
          if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
        }
        lastAttemptNanos = yield* Clock.monotonicTimeNanos;
        return yield* recover(config);
      }).pipe(
        Effect.retry({
          while: isRetryable,
          schedule: Schedule.exponential("1 second").pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Duration.min(duration, Duration.seconds(30))),
            ),
            Schedule.jittered,
          ),
        }),
      ),
    );
});
