import * as Lambda from "@/AWS/Lambda";
import * as MemoryDB from "@/AWS/MemoryDB";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class MemoryDBBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "MemoryDBBindingsTestFunction",
) {}

/**
 * Account-level binding fixture: no MemoryDB cluster is ever created (a
 * cluster takes 10-15 minutes and bills per node). List routes prove each
 * grant and response decode against real (possibly empty) account data;
 * probe routes drive name-addressed operations against nonexistent names
 * (passed by the test as a query parameter) and must surface the service's
 * typed not-found tag — an IAM gap would surface AccessDeniedException and
 * fail the route with an opaque 500.
 *
 * The cluster-scoped `Connect`, `CreateSnapshot`, and `FailoverShard`
 * bindings need a live cluster and are exercised only alongside the
 * AWS_TEST_SLOW-gated cluster lifecycle.
 */
export default MemoryDBBindingsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const describeClusters = yield* MemoryDB.DescribeClusters();
    const describeSnapshots = yield* MemoryDB.DescribeSnapshots();
    const describeEvents = yield* MemoryDB.DescribeEvents();
    const deleteSnapshot = yield* MemoryDB.DeleteSnapshot();
    const copySnapshot = yield* MemoryDB.CopySnapshot();
    const describeServiceUpdates = yield* MemoryDB.DescribeServiceUpdates();
    const describeEngineVersions = yield* MemoryDB.DescribeEngineVersions();
    const batchUpdateCluster = yield* MemoryDB.BatchUpdateCluster();

    const bound = {
      describeClusters,
      describeSnapshots,
      describeEvents,
      deleteSnapshot,
      copySnapshot,
      describeServiceUpdates,
      describeEngineVersions,
      batchUpdateCluster,
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

        if (request.method === "GET" && pathname === "/clusters") {
          const result = yield* describeClusters();
          return yield* HttpServerResponse.json({
            count: (result.Clusters ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/cluster-probe") {
          const tag = yield* describeClusters({ ClusterName: name }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ClusterNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          const result = yield* describeSnapshots();
          return yield* HttpServerResponse.json({
            count: (result.Snapshots ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/events") {
          const result = yield* describeEvents({ SourceType: "cluster" });
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/delete-probe") {
          const tag = yield* deleteSnapshot({ SnapshotName: name }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag(
              ["SnapshotNotFoundFault", "ServiceLinkedRoleNotFoundFault"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/service-updates") {
          const result = yield* describeServiceUpdates();
          return yield* HttpServerResponse.json({
            count: (result.ServiceUpdates ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/engine-versions") {
          const result = yield* describeEngineVersions({ Engine: "valkey" });
          return yield* HttpServerResponse.json({
            count: (result.EngineVersions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/batch-probe") {
          // A nonexistent service update is rejected with the typed
          // ServiceUpdateNotFoundFault ("Service Update ... not found") —
          // proving the grant and the typed union. A call with NO
          // ServiceUpdate instead fails with the (distilled-patched)
          // InvalidParameterCombinationException "No modifications were
          // requested". An IAM gap would surface AccessDeniedException and
          // 500 the route.
          const result = yield* batchUpdateCluster({
            ClusterNames: [name],
            ServiceUpdate: {
              ServiceUpdateNameToApply: `${name}-service-update`,
            },
          }).pipe(
            Effect.map((r) => ({
              unprocessed: (r.UnprocessedClusters ?? []).length,
              tag: "Ok",
            })),
            Effect.catchTag(
              [
                "InvalidParameterCombinationException",
                "InvalidParameterValueException",
                "ServiceUpdateNotFoundFault",
              ],
              (e) => Effect.succeed({ unprocessed: 0, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/copy-probe") {
          const tag = yield* copySnapshot({
            SourceSnapshotName: name,
            TargetSnapshotName: `${name}-copy`,
          }).pipe(
            Effect.map(() => "Copied"),
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
        MemoryDB.DescribeClustersHttp,
        MemoryDB.DescribeSnapshotsHttp,
        MemoryDB.DescribeEventsHttp,
        MemoryDB.DeleteSnapshotHttp,
        MemoryDB.CopySnapshotHttp,
        MemoryDB.DescribeServiceUpdatesHttp,
        MemoryDB.DescribeEngineVersionsHttp,
        MemoryDB.BatchUpdateClusterHttp,
      ),
    ),
  ),
);
