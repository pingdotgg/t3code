import * as AWS from "@/AWS";
import type { CacheConnectionInfo } from "@/AWS/ElastiCache";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Valkey from "iovalkey";
import { getDefaultVpc } from "../DefaultVpc.ts";

export class ElastiCacheTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "ElastiCacheTestFunction",
) {}

export class FixtureCache extends Context.Service<
  FixtureCache,
  {
    cache: AWS.ElastiCache.ServerlessCache;
  }
>()("FixtureCache") {}

export const FixtureCacheLive = Layer.effect(
  FixtureCache,
  Effect.gen(function* () {
    // Valkey is the cheapest engine; usage limits are pinned to the service
    // minimums (1 GB storage, 1000 ECPUs/s) purely for cost control. Subnets
    // and security group are left to the API defaults: the account's default
    // VPC and its DEFAULT security group — the same network the fixture
    // Lambda attaches to below.
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

/**
 * Resolve the default VPC's default-for-AZ subnets and its DEFAULT security
 * group for the fixture Lambda's VPC attachment.
 *
 * The default group is used on purpose (same rationale as the EFS Lambda
 * mount test): its self-referencing ingress rule allows the Lambda ENI to
 * reach the cache endpoint on 6379 (the serverless cache sits in the same
 * default VPC + default SG by API default), and because the default group is
 * never deleted, destroy avoids the ~20-minute Hyperplane ENI release that
 * blocks deleting a security group that was attached to a Lambda.
 *
 * Runtime-guarded: the Lambda runtime re-executes this props effect on cold
 * start, but VPC attachment is deploy-time-only configuration and the
 * execution role has no ec2:Describe* permissions — return `undefined` there
 * without touching the EC2 API.
 */
const resolveFixtureVpc = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) {
    return undefined;
  }
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .map((subnet) => subnet.SubnetId)
    .filter((subnetId): subnetId is string => subnetId !== undefined)
    .sort()
    .slice(0, 2);
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const securityGroupId = groups.SecurityGroups?.[0]?.GroupId;
  if (subnetIds.length === 0 || securityGroupId === undefined) {
    return yield* Effect.die(
      new Error(
        "default VPC is missing default-for-AZ subnets or its default security group",
      ),
    );
  }
  return { subnetIds, securityGroupIds: [securityGroupId] };
}).pipe(Effect.orDie);

/**
 * SET then GET a key through the serverless cache with iovalkey. Serverless
 * caches only accept TLS connections, so `tls` is always enabled from the
 * binding's connection info. One client per request: connect, round-trip,
 * disconnect — sockets must not be retained across invocations.
 */
const cacheRoundtrip = (info: CacheConnectionInfo, value: string) =>
  Effect.tryPromise({
    try: async () => {
      const client = new Valkey({
        host: info.host,
        port: info.port,
        ...(info.tls ? { tls: {} } : {}),
        connectTimeout: 10_000,
        maxRetriesPerRequest: 2,
        // Fail fast instead of reconnecting forever — the route must answer
        // (or error) within the Lambda's 30s timeout.
        retryStrategy: (times) => (times > 2 ? null : 500),
      });
      try {
        await client.set("alchemy:elasticache:roundtrip", value);
        return await client.get("alchemy:elasticache:roundtrip");
      } finally {
        client.disconnect();
      }
    },
    catch: (cause) => new Error(`valkey roundtrip failed: ${String(cause)}`),
  });

/**
 * VPC-attached fixture Lambda exercising the full ElastiCache data plane:
 *
 * - `/connection` returns the endpoint the env-only Connect binding resolved
 *   from the injected environment.
 * - `/roundtrip?value=...` SETs then GETs a key through the cache over TLS
 *   with iovalkey and returns the read-back value.
 * - `/snapshot?name=...` takes an on-demand snapshot of the fixture cache
 *   through the cache-scoped CreateServerlessCacheSnapshot binding.
 */
export const ElastiCacheTestFunctionLive = ElastiCacheTestFunction.make(
  Effect.gen(function* () {
    const vpc = yield* resolveFixtureVpc;
    return {
      main: import.meta.url,
      url: true,
      timeout: Duration.seconds(30),
      memorySize: 256,
      ...(vpc === undefined ? {} : { vpc }),
    };
  }),
  Effect.gen(function* () {
    const { cache } = yield* FixtureCache;
    const connection = yield* AWS.ElastiCache.Connect(cache);
    const createSnapshot =
      yield* AWS.ElastiCache.CreateServerlessCacheSnapshot(cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/connection") {
          return yield* HttpServerResponse.json(yield* connection);
        }

        if (request.method === "GET" && pathname === "/snapshot") {
          const name = url.searchParams.get("name") ?? "alchemy-fixture-snap";
          return yield* createSnapshot({
            ServerlessCacheSnapshotName: name,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                name: result.ServerlessCacheSnapshot
                  ?.ServerlessCacheSnapshotName,
                status: result.ServerlessCacheSnapshot?.Status,
              }),
            ),
            // Re-run after a crashed test: the snapshot already exists.
            Effect.catchTag("ServerlessCacheSnapshotAlreadyExistsFault", () =>
              HttpServerResponse.json({ name, status: "exists" }),
            ),
            Effect.catch((error) =>
              HttpServerResponse.json({ error: error._tag }, { status: 500 }),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/roundtrip") {
          const info = yield* connection;
          const value = url.searchParams.get("value") ?? "hello-valkey";
          return yield* cacheRoundtrip(info, value).pipe(
            Effect.flatMap((read) => HttpServerResponse.json({ value: read })),
            Effect.catch((error) =>
              HttpServerResponse.json(
                { error: String(error) },
                { status: 500 },
              ),
            ),
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.ElastiCache.ConnectHttp,
        AWS.ElastiCache.CreateServerlessCacheSnapshotHttp,
        FixtureCacheLive,
      ),
    ),
  ),
  // Re-merge so the deploying Stack can `yield* FixtureCache` and expose the
  // cache attributes as deploy-time outputs. Reusing the same
  // `FixtureCacheLive` reference keeps it a single shared cache.
).pipe(Layer.provideMerge(FixtureCacheLive));

export default ElastiCacheTestFunctionLive;
