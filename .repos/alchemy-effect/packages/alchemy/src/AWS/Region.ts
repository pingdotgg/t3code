import * as Region from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export { AWS_REGION, type RegionID } from "./Environment.ts";
export { Region } from "@distilled.cloud/aws/Region";

declare module "@distilled.cloud/aws/Region" {
  interface Region {
    readonly kind: "Environment";
  }
}

export const of = (region: string) =>
  Layer.succeed(Region.Region, Effect.succeed(region));

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(
    Region.Region,
    Effect.succeed(process.env.AWS_REGION ?? region),
  );

// Deferred with `Effect.suspend` so it does not dereference `AWSEnvironment`
// during module evaluation. `Region.ts` and `Environment.ts` are part of an
// import cycle (AuthProvider → Region → Environment → AuthProvider); touching
// `AWSEnvironment` eagerly at top level hits a temporal-dead-zone error when
// this module is evaluated mid-cycle.
export const CurrentRegion = Effect.suspend(() =>
  AWSEnvironment.use((env) =>
    Effect.flatMap(env, ({ region }) => Effect.succeed(region)),
  ),
);

/**
 * Derive the AWS region from the surrounding {@link AWSEnvironment}.
 */
export const fromEnvironment = Layer.effect(
  Region.Region,
  Effect.gen(function* () {
    const env = yield* AWSEnvironment;
    return Effect.map(env, (env) => env.region);
  }),
);
