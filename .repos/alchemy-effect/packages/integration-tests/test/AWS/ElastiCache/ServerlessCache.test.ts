import * as AWS from "@alchemy.run/aws";
import { connectEnvPrefix } from "@alchemy.run/aws/ElastiCache";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { FixtureCache } from "./fixture-cache.ts";
import ElastiCacheTestFunctionLive, { ElastiCacheTestFunction } from "./handler.ts";
import ElastiCacheSnapshotFunctionLive, {
  ElastiCacheSnapshotFunction,
} from "./snapshot-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeServerlessCaches on a nonexistent cache fails with ServerlessCacheNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ElastiCache.describeServerlessCaches({
          ServerlessCacheName: "alchemy-nonexistent-cache-probe",
        }),
      );
      expect(error._tag).toBe("ServerlessCacheNotFoundFault");
    }),
  { tags: ["provider:aws", "provider:aws:elasticache", "live"] },
);

const SNAPSHOT_NAME = "alchemy-elasticache-fixture-snap";

// A snapshot still `creating` rejects deletion with
// InvalidServerlessCacheSnapshotStateFault — retry (bounded) while it
// settles. Already gone is success. An on-demand snapshot of even an empty
// serverless cache can stay `creating` for 5+ minutes, so the budget is
// ~10 min; the test destroys the (billed) cache BEFORE waiting on this.
const deleteSnapshot = (name: string) =>
  ElastiCache.deleteServerlessCacheSnapshot({
    ServerlessCacheSnapshotName: name,
  }).pipe(
    Effect.asVoid,
    Effect.catchTag("ServerlessCacheSnapshotNotFoundFault", () => Effect.void),
    Effect.retry({
      while: (e): boolean => e._tag === "InvalidServerlessCacheSnapshotStateFault",
      schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(40)]),
    }),
  );

// Serverless caches take ~1-3 minutes to provision and a similar time to
// delete, and are metered (with a monthly floor) while they exist. The full
// lifecycle is therefore skipped under `--fast` and runs as a single
// sequential test that always destroys what it created.
test.provider.skipIf(!!process.env.FAST)(
  "create serverless cache, bind Connect env, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight (the snapshot is
      // created out-of-band of the stack, so it needs its own cleanup).
      yield* stack.destroy();
      yield* deleteSnapshot(SNAPSHOT_NAME);

      const { cache, fn, snapshotFn } = yield* stack.deploy(
        Effect.gen(function* () {
          const { cache } = yield* FixtureCache;
          const fn = yield* ElastiCacheTestFunction;
          const snapshotFn = yield* ElastiCacheSnapshotFunction;
          return { cache, fn, snapshotFn };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(ElastiCacheTestFunctionLive, ElastiCacheSnapshotFunctionLive),
          ),
        ),
      );

      expect(cache.serverlessCacheName).toBeDefined();
      expect(cache.serverlessCacheArn).toContain(":serverlesscache:");
      expect(cache.engine).toBe("valkey");
      expect(cache.endpointAddress).toContain("cache.amazonaws.com");
      expect(cache.endpointPort).toBe(6379);

      // Out-of-band verification via distilled: cache is live with the
      // requested cost-control limits.
      const described = yield* ElastiCache.describeServerlessCaches({
        ServerlessCacheName: cache.serverlessCacheName,
      });
      const observed = described.ServerlessCaches?.[0];
      expect(observed?.Status).toBe("available");
      expect(observed?.CacheUsageLimits?.DataStorage?.Maximum).toBe(1);
      expect(observed?.CacheUsageLimits?.ECPUPerSecond?.Maximum).toBe(1000);

      // Env-only Connect binding: the deployed function's configuration
      // must carry the endpoint env vars.
      const config = yield* Lambda.getFunctionConfiguration({
        FunctionName: fn.functionName,
      });
      const prefix = connectEnvPrefix("FixtureCache");
      const env = config.Environment?.Variables ?? {};
      // Distilled decodes Lambda env values as sensitive (Redacted) strings.
      const envValue = (key: string) => {
        const value = env[key];
        return value === undefined || typeof value === "string" ? value : Redacted.value(value);
      };
      expect(envValue(`${prefix}_HOST`)).toBe(cache.endpointAddress);
      expect(envValue(`${prefix}_PORT`)).toBe(String(cache.endpointPort));
      expect(envValue(`${prefix}_TLS`)).toBe("true");

      // Runtime shape: the binding resolves the same connection info inside
      // the deployed function. The first request rides URL propagation AND
      // the VPC-attached cold start (ENI provisioning), so budget a generous
      // bounded retry (3s x 60 ≈ 180s).
      const baseUrl = fn.functionUrl!.replace(/\/+$/, "");
      const getJson = (path: string, times: number, base = baseUrl) =>
        HttpClient.get(`${base}${path}`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : res.text.pipe(
                  Effect.flatMap((body) =>
                    Effect.fail(new Error(`${path} returned ${res.status}: ${body}`)),
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(times)]),
          }),
        );
      const response = yield* getJson("/connection", 60);
      expect((response as { host: string }).host).toBe(cache.endpointAddress);
      expect((response as { port: number }).port).toBe(cache.endpointPort);
      expect((response as { tls: boolean }).tls).toBe(true);

      // Data-plane roundtrip: the VPC-attached function SETs then GETs a key
      // through the cache over TLS with iovalkey and returns the read-back
      // value.
      const roundtrip = yield* getJson("/roundtrip?value=hello-valkey", 10);
      expect((roundtrip as { value: string }).value).toBe("hello-valkey");

      // Cache-scoped CreateServerlessCacheSnapshot binding: take an
      // on-demand snapshot from the (non-VPC) control-plane function, verify
      // it out-of-band, then delete it (snapshots bill per GB-month).
      const snapshotBaseUrl = snapshotFn.functionUrl!.replace(/\/+$/, "");
      const snapshot = (yield* getJson(`/snapshot?name=${SNAPSHOT_NAME}`, 10, snapshotBaseUrl)) as {
        name: string;
        status: string;
      };
      expect(snapshot.name).toBe(SNAPSHOT_NAME);
      expect(["creating", "available", "exists"]).toContain(snapshot.status);
      const describedSnapshots = yield* ElastiCache.describeServerlessCacheSnapshots({
        ServerlessCacheSnapshotName: SNAPSHOT_NAME,
      });
      expect(describedSnapshots.ServerlessCacheSnapshots?.[0]?.ServerlessCacheSnapshotName).toBe(
        SNAPSHOT_NAME,
      );

      // Destroy immediately — serverless caches bill while they exist —
      // and verify deletion out-of-band with a typed wait. The snapshot is
      // deleted afterwards (see the `ensuring` below) since it can take
      // minutes to leave `creating`.
      yield* stack.destroy();
      yield* assertCacheDeleted(cache.serverlessCacheName);
    }).pipe(
      // The snapshot is created out-of-band of the stack — clean it up on
      // every exit path so a failed run never leaves it billing.
      Effect.ensuring(deleteSnapshot(SNAPSHOT_NAME).pipe(Effect.orDie)),
    ),
  // create (~2-4 min) + lambda deploy (~1-3 min, VPC ENIs) + delete
  // initiation + snapshot settle-and-delete (up to ~10 min), one test.
  {
    tags: [
      "provider:aws",
      "provider:aws:ec2",
      "provider:aws:elasticache",
      "provider:aws:lambda",
      "live",
    ],
    timeout: 1_500_000,
  },
);

// Deletion is verified as INITIATED (status `deleting`, which is
// irreversible) or fully gone. Full disappearance takes another ~8 minutes
// server-side; waiting for it would push the test into its timeout and —
// with vitest's global `retry: 2` — trigger pointless create/destroy churn
// of a billed resource.
const assertCacheDeleted = (name: string) =>
  Effect.gen(function* () {
    const status = yield* ElastiCache.describeServerlessCaches({
      ServerlessCacheName: name,
    }).pipe(
      Effect.map((r) => r.ServerlessCaches?.[0]?.Status ?? "gone"),
      Effect.catchTag("ServerlessCacheNotFoundFault", () => Effect.succeed("gone" as const)),
    );
    if (status !== "gone" && status !== "deleting") {
      return yield* Effect.fail(
        new Error(`Serverless cache '${name}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
    }),
  );
