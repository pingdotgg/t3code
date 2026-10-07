import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

const timeout = Config.schema(
  Schema.DurationFromString.pipe(
    Schema.check(
      Schema.makeFilter<Duration.Duration>((value) =>
        Duration.isFinite(value) && Duration.isPositive(value)
          ? true
          : "Expected a positive finite duration",
      ),
    ),
  ),
  "AWS_CLIENT_VPN_TIMEOUT",
).pipe(Config.withDefault(Duration.minutes(30)));

// Matches the Terraform AWS provider's Client VPN association and route timeouts.
export const retryClientVpn = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  whilePending: (error: E) => boolean,
) =>
  Effect.gen(function* () {
    const duration = yield* timeout;
    return yield* effect.pipe(
      Effect.retry({
        while: whilePending,
        schedule: Schedule.spaced("5 seconds").pipe(
          Schedule.upTo({ duration }),
        ),
      }),
    );
  });
