import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";

// The AWS Price List Query API is only served from us-east-1 (and ap-south-1),
// regardless of where the calling function runs. Pin every pricing call to
// us-east-1 so a Lambda deployed in any region resolves a valid endpoint.
//
// NOTE: the distilled Region service value is `Effect<RegionName>`, not a raw
// string — providing a bare string makes the client `yield*` a string and
// crash. Wrap in Effect.succeed (same as CloudFront KVS / ACM / WAFv2).
export const PRICING_REGION = "us-east-1" as const;

export const withPricingRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed(PRICING_REGION)));
