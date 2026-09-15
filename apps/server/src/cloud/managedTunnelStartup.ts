import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export type ManagedTunnelRegistrationResult =
  | { readonly status: "not_linked" | "ready" | "unavailable" | "superseded" }
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

// Registration retries stop here. After that the host falls back to its
// stored connector config rather than staying offline while the relay is down.
const MANAGED_TUNNEL_REGISTRATION_RETRY_WINDOW = Duration.minutes(10);

export const retryManagedTunnelRegistration = <A, E, R>(
  registration: Effect.Effect<A, E, R>,
  isRetryable: (error: E) => boolean,
) =>
  registration.pipe(
    Effect.retry({
      while: isRetryable,
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
        ),
        Schedule.jittered,
        Schedule.upTo({ duration: MANAGED_TUNNEL_REGISTRATION_RETRY_WINDOW }),
      ),
    }),
  );

// A host asks the relay for a replacement tunnel at most this often. Every
// managed host shares one relay, so a host stuck in a bad loop must not turn
// into a fleet-wide request storm.
export const MANAGED_TUNNEL_RECOVERY_COOLDOWN = Duration.minutes(2);

// Existing hosts register on their first boot after an upgrade, and desktop
// auto-update delivers that boot to many hosts at once. Spread the first
// registration so the relay and Cloudflare see a ramp instead of a spike.
export const MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER = Duration.seconds(30);
