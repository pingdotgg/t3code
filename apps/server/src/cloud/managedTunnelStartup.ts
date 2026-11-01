import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { isRelayUnavailable, relayRetryAfterMillis } from "./relayResponse.ts";

// Relinking revoked environments is the user's choice; startup takes no action.
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

// Back off to minutes and honor Retry-After to avoid adding load to a failing relay.
// Retries must rerun the operation: HttpClient.retryTransient would reuse proofs that
// expire after 60 s or single-use link challenges.
const RELAY_RETRY_MAX_DELAY = Duration.minutes(5);

const relayRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, RELAY_RETRY_MAX_DELAY)),
  ),
  Schedule.modifyDelay(({ duration, input }) => {
    const retryAfterMillis = relayRetryAfterMillis(input);
    return Effect.succeed(
      retryAfterMillis === undefined
        ? duration
        : Duration.max(duration, Duration.millis(retryAfterMillis)),
    );
  }),
);

const windowMillis = Duration.toMillis(MANAGED_TUNNEL_REGISTRATION_RETRY_WINDOW);

/**
 * Retries on the relay schedule. The window closes at the first sleep that
 * would end past it: then `onWindowExhausted` runs, and retrying continues
 * only while `whilePastWindow` holds. One schedule covers both sides, so the
 * relay's Retry-After still holds across the handoff.
 */
const retryAcrossWindow = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly while: (error: E) => boolean;
    readonly whilePastWindow: (error: E) => boolean;
    readonly onWindowExhausted: (error: E) => Effect.Effect<void, never, R>;
  },
) =>
  Effect.suspend(() => {
    let pastWindow = false;
    return effect.pipe(
      Effect.retry({
        while: (error) => (pastWindow ? options.whilePastWindow(error) : options.while(error)),
        schedule: relayRetrySchedule.pipe(
          Schedule.setInputType<E>(),
          Schedule.modifyDelay(({ duration, elapsed, input }) => {
            if (pastWindow || elapsed + Duration.toMillis(duration) < windowMillis) {
              return Effect.succeed(duration);
            }
            pastWindow = true;
            return options.whilePastWindow(input)
              ? options.onWindowExhausted(input).pipe(Effect.as(duration))
              : Effect.fail(input);
          }),
        ),
      }),
    );
  });

export const retryManagedTunnelRegistration = <A, E, R>(
  registration: Effect.Effect<A, E, R>,
  isRetryable: (error: E) => boolean,
  onRetryWindowExhausted?: Effect.Effect<void, never, R>,
) =>
  retryAcrossWindow(registration, {
    while: isRetryable,
    whilePastWindow: onRetryWindowExhausted === undefined ? () => false : isRetryable,
    onWindowExhausted: () => onRetryWindowExhausted ?? Effect.void,
  });

/**
 * Relinks a desired link at startup. Past the retry window it keeps going only
 * while the relay itself is unavailable: a headless host has nobody to restart
 * it once the relay recovers, but a local failure (cloudflared that cannot run)
 * would otherwise relink, and provision a tunnel, forever.
 */
export const retryDesiredLinkReconcile = <A, E, R>(
  reconcile: Effect.Effect<A, E, R>,
  isRetryable: (error: E) => boolean,
  onRetryWindowExhausted: (error: E) => Effect.Effect<void, never, R>,
) =>
  retryAcrossWindow(reconcile, {
    while: isRetryable,
    whilePastWindow: isRelayUnavailable,
    onWindowExhausted: onRetryWindowExhausted,
  });

// Every managed host shares one relay, so a host stuck in a bad loop must not
// turn into a fleet-wide request storm.
const MANAGED_TUNNEL_RECOVERY_COOLDOWN = Duration.minutes(2);

// Retries inside one recovery, while the relay keeps failing, stay at least a
// cooldown apart. They do not grow the cooldown: only a new request does.
const managedTunnelRecoveryRetrySchedule = relayRetrySchedule.pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.max(duration, MANAGED_TUNNEL_RECOVERY_COOLDOWN)),
  ),
);
const MANAGED_TUNNEL_RECOVERY_MAX_COOLDOWN = Duration.minutes(30);
// A recovery that fixed the tunnel stops the runtime asking for another, so a
// request this long after the cooldown means the previous one worked.
const MANAGED_TUNNEL_RECOVERY_SETTLED_AFTER = Duration.minutes(10);

/**
 * Recovery can only replace the relay-side tunnel. When the connector keeps
 * failing for local reasons (no network, a firewall), the runtime keeps asking
 * and recovery cannot help, so each request that follows right after a
 * recovery doubles the wait, up to 30 minutes.
 */
function nextManagedTunnelRecoveryCooldown(input: {
  readonly current: Duration.Duration;
  readonly sinceLastRecovery: Duration.Duration;
}): Duration.Duration {
  const settled = Duration.sum(input.current, MANAGED_TUNNEL_RECOVERY_SETTLED_AFTER);
  if (Duration.isGreaterThanOrEqualTo(input.sinceLastRecovery, settled)) {
    return MANAGED_TUNNEL_RECOVERY_COOLDOWN;
  }
  return Duration.min(Duration.times(input.current, 2), MANAGED_TUNNEL_RECOVERY_MAX_COOLDOWN);
}

// Existing hosts register on their first boot after an upgrade, and desktop
// auto-update delivers that boot to many hosts at once. Spread the first
// registration so the relay and Cloudflare see a ramp instead of a spike.
export const MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER = Duration.seconds(30);

/**
 * Runs one recovery per request, one at a time: waits out the current
 * cooldown, then calls the relay, retrying it while it stays unavailable.
 */
export const makeManagedTunnelRecovery = Effect.fn("ManagedTunnelRecovery.make")(function* <
  A,
  E,
  R,
>(options: {
  readonly recover: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<A, E, R>;
  readonly isRetryable: (error: E) => boolean;
}) {
  const lock = yield* Semaphore.make(1);
  let lastRecoveryAtMillis = Number.NEGATIVE_INFINITY;
  let cooldown = MANAGED_TUNNEL_RECOVERY_COOLDOWN;
  const waitForCooldown = Effect.gen(function* () {
    const elapsed = (yield* Clock.currentTimeMillis) - lastRecoveryAtMillis;
    cooldown = nextManagedTunnelRecoveryCooldown({
      current: cooldown,
      sinceLastRecovery: Duration.millis(elapsed),
    });
    const wait = Duration.toMillis(cooldown) - elapsed;
    if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
  });
  // Measured from the end: a recovery that retried through a long relay
  // outage must not look settled the moment it finishes.
  const recordRecovery = Clock.currentTimeMillis.pipe(
    Effect.tap((now) =>
      Effect.sync(() => {
        lastRecoveryAtMillis = now;
      }),
    ),
  );
  return (config: RelayManagedEndpointRuntimeConfig) =>
    lock.withPermits(1)(
      waitForCooldown.pipe(
        Effect.andThen(
          options.recover(config).pipe(
            Effect.retry({
              while: options.isRetryable,
              schedule: managedTunnelRecoveryRetrySchedule,
            }),
            Effect.ensuring(recordRecovery),
          ),
        ),
      ),
    );
});
