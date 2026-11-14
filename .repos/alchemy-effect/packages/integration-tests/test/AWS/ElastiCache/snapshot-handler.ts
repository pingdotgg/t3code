import * as AWS from "@alchemy.run/aws";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { FixtureCache, FixtureCacheLive } from "./fixture-cache.ts";

export class ElastiCacheSnapshotFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "ElastiCacheSnapshotFunction",
) {}

/**
 * Control-plane fixture for the cache-scoped CreateServerlessCacheSnapshot
 * binding. Deliberately NOT VPC-attached: the default VPC has no NAT gateway
 * or ElastiCache interface endpoint, so a VPC-attached Lambda cannot reach
 * the ElastiCache API (the call hangs until the function times out and the
 * Function URL answers 502).
 *
 * - `/snapshot?name=...` takes an on-demand snapshot of the fixture cache.
 */
export const ElastiCacheSnapshotFunctionLive = ElastiCacheSnapshotFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { cache } = yield* FixtureCache;
    const createSnapshot = yield* AWS.ElastiCache.CreateServerlessCacheSnapshot(cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/snapshot") {
          const name = url.searchParams.get("name") ?? "alchemy-fixture-snap";
          return yield* createSnapshot({
            ServerlessCacheSnapshotName: name,
          }).pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({
                name: result.ServerlessCacheSnapshot?.ServerlessCacheSnapshotName,
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

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(AWS.ElastiCache.CreateServerlessCacheSnapshotHttp, FixtureCacheLive),
    ),
  ),
);

export default ElastiCacheSnapshotFunctionLive;
