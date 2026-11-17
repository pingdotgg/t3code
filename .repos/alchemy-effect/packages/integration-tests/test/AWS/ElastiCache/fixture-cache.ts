import * as AWS from "@alchemy.run/aws";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class FixtureCache extends Context.Service<
  FixtureCache,
  {
    cache: AWS.ElastiCache.ServerlessCache;
  }
>()("FixtureCache") {}

/**
 * The serverless cache shared by the VPC-attached data-plane fixture
 * (`handler.ts`) and the control-plane snapshot fixture
 * (`snapshot-handler.ts`). Both Lambdas provide this same layer reference,
 * so the stack declares a single cache.
 */
export const FixtureCacheLive = Layer.effect(
  FixtureCache,
  Effect.gen(function* () {
    // Valkey is the cheapest engine; usage limits are pinned to the service
    // minimums (1 GB storage, 1000 ECPUs/s) purely for cost control. Subnets
    // and security group are left to the API defaults: the account's default
    // VPC and its DEFAULT security group — the same network the data-plane
    // fixture Lambda attaches to.
    const cache = yield* AWS.ElastiCache.ServerlessCache("FixtureCache", {
      engine: "valkey",
      description: "alchemy elasticache fixture",
      cacheUsageLimits: {
        dataStorage: { maximum: 1 },
        ecpuPerSecond: { maximum: 1000 },
      },
      tags: { fixture: "elasticache-serverless" },
    });
    return { cache };
  }),
);
