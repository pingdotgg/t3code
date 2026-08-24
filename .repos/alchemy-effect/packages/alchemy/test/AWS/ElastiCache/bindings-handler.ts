import * as ElastiCache from "@/AWS/ElastiCache";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class ElastiCacheBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "ElastiCacheBindingsTestFunction",
) {}

/**
 * Account-level binding fixture: no serverless cache is ever created. List
 * routes prove each grant and response decode against real (possibly empty)
 * account data; probe routes drive name-addressed operations against
 * nonexistent names (passed by the test as a query parameter) and must
 * surface the service's typed not-found tag — an IAM gap would surface
 * AccessDeniedException and fail the route with an opaque 500.
 *
 * The cache-scoped `CreateServerlessCacheSnapshot` binding needs a live
 * cache and is exercised by the AWS_TEST_SLOW-gated lifecycle fixture
 * instead.
 */
export default ElastiCacheBindingsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to ElastiCache cache/snapshot
    // lifecycle events. The deploy proves the EventBridge rule + invoke
    // permission wiring.
    yield* ElastiCache.consumeCacheEvents(
      { kinds: ["cache-limit-approaching", "snapshot-creation-failed"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `elasticache event: ${event["detail-type"]} -> ${event.resources.join(", ")}`,
          ),
        ),
    );

    const describeCaches = yield* ElastiCache.DescribeServerlessCaches();
    const describeSnapshots =
      yield* ElastiCache.DescribeServerlessCacheSnapshots();
    const deleteSnapshot = yield* ElastiCache.DeleteServerlessCacheSnapshot();
    const copySnapshot = yield* ElastiCache.CopyServerlessCacheSnapshot();
    const exportSnapshot = yield* ElastiCache.ExportServerlessCacheSnapshot();
    const describeEvents = yield* ElastiCache.DescribeEvents();

    const bound = {
      describeCaches,
      describeSnapshots,
      deleteSnapshot,
      copySnapshot,
      exportSnapshot,
      describeEvents,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const name = url.searchParams.get("name") ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/caches") {
          const result = yield* describeCaches();
          return yield* HttpServerResponse.json({
            count: (result.ServerlessCaches ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          const result = yield* describeSnapshots();
          return yield* HttpServerResponse.json({
            count: (result.ServerlessCacheSnapshots ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/events") {
          const result = yield* describeEvents({
            SourceType: "serverless-cache",
          });
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/cache-probe") {
          const tag = yield* describeCaches({
            ServerlessCacheName: name,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ServerlessCacheNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/delete-probe") {
          // ElastiCache validates the account's service-linked role before
          // snapshot existence, so an account that never kept a cache
          // surfaces ServiceLinkedRoleNotFoundFault instead of not-found.
          const tag = yield* deleteSnapshot({
            ServerlessCacheSnapshotName: name,
          }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag(
              [
                "ServerlessCacheSnapshotNotFoundFault",
                "ServiceLinkedRoleNotFoundFault",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/copy-probe") {
          const tag = yield* copySnapshot({
            SourceServerlessCacheSnapshotName: name,
            TargetServerlessCacheSnapshotName: `${name}-copy`,
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/export-probe") {
          const tag = yield* exportSnapshot({
            ServerlessCacheSnapshotName: name,
            S3BucketName: "alchemy-elasticache-export-probe",
          }).pipe(
            Effect.map(() => "Exported"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
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
        Lambda.EventSource,
        ElastiCache.DescribeServerlessCachesHttp,
        ElastiCache.DescribeServerlessCacheSnapshotsHttp,
        ElastiCache.DeleteServerlessCacheSnapshotHttp,
        ElastiCache.CopyServerlessCacheSnapshotHttp,
        ElastiCache.ExportServerlessCacheSnapshotHttp,
        ElastiCache.DescribeEventsHttp,
      ),
    ),
  ),
);
