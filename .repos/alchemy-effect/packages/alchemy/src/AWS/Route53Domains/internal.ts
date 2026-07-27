import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";

// The Route 53 Domains API is global and only served from us-east-1,
// regardless of where the calling function runs. Pin every call to
// us-east-1 so a Lambda deployed in any region resolves a valid endpoint.
//
// NOTE: the distilled Region service value is `Effect<RegionName>`, not a raw
// string — providing a bare string makes the client `yield*` a string and
// crash. Wrap in Effect.succeed (same as Pricing / CloudFront KVS / ACM).
export const ROUTE53_DOMAINS_REGION = "us-east-1" as const;

export const withRoute53DomainsRegion = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provideService(AwsRegion, Effect.succeed(ROUTE53_DOMAINS_REGION)),
  );
