import * as Lambda from "@/AWS/Lambda";
import * as Neptune from "@/AWS/Neptune";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed-but-nonexistent identifiers — the probe routes drive the
// bindings against them so the fixture exercises the IAM grants and the
// typed error decode at zero cost (no cluster/snapshot is ever created).
const NONEXISTENT_CLUSTER_ID = "alchemy-nonexistent-neptune-probe";
const NONEXISTENT_INSTANCE_ID = "alchemy-nonexistent-neptune-instance-probe";
const NONEXISTENT_SNAPSHOT_ID = "alchemy-nonexistent-neptune-snapshot-probe";

export class NeptuneBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "NeptuneBindingsTestFunction",
) {}

/**
 * Account-level binding fixture: no Neptune cluster is ever created. List
 * routes prove each grant and response decode against real (possibly empty)
 * account data; probe routes drive identifier-addressed operations against
 * nonexistent identifiers and must surface the service's typed not-found
 * tag — an IAM gap would surface AccessDeniedException and fail the route
 * with an opaque 500.
 *
 * The cluster/instance-scoped bindings (`CreateDBClusterSnapshot`,
 * `FailoverDBCluster`, `StartDBCluster`, `StopDBCluster`,
 * `RebootDBInstance`) resolve a bound resource at deploy time, so they need
 * a live cluster (~10 min, billed hourly) and are exercised only under
 * AWS_TEST_SLOW-gated lifecycle runs.
 */
export default NeptuneBindingsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to Neptune cluster events flowing
    // through the shared RDS eventing plane. The deploy proves the
    // EventBridge rule + invoke permission wiring.
    yield* Neptune.consumeNeptuneEvents(
      { kinds: ["db-cluster", "db-cluster-snapshot"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `neptune event: ${event["detail-type"]} -> ${event.resources.join(", ")}`,
          ),
        ),
    );

    const describeDBClusters = yield* Neptune.DescribeDBClusters();
    const describeDBInstances = yield* Neptune.DescribeDBInstances();
    const describeDBClusterEndpoints =
      yield* Neptune.DescribeDBClusterEndpoints();
    const describeEvents = yield* Neptune.DescribeEvents();
    const describeDBClusterSnapshots =
      yield* Neptune.DescribeDBClusterSnapshots();
    const deleteDBClusterSnapshot = yield* Neptune.DeleteDBClusterSnapshot();
    const copyDBClusterSnapshot = yield* Neptune.CopyDBClusterSnapshot();
    const describePendingMaintenanceActions =
      yield* Neptune.DescribePendingMaintenanceActions();
    const applyPendingMaintenanceAction =
      yield* Neptune.ApplyPendingMaintenanceAction();

    const bound = {
      describeDBClusters,
      describeDBInstances,
      describeDBClusterEndpoints,
      describeEvents,
      describeDBClusterSnapshots,
      deleteDBClusterSnapshot,
      copyDBClusterSnapshot,
      describePendingMaintenanceActions,
      applyPendingMaintenanceAction,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/clusters") {
          // A nonexistent cluster identifier must surface the service's
          // typed not-found tag — an IAM gap would surface
          // AccessDeniedException and fail the route with an opaque 500.
          const tag = yield* describeDBClusters({
            DBClusterIdentifier: NONEXISTENT_CLUSTER_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("DBClusterNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/instances") {
          // Nonexistent instance identifier → typed not-found tag.
          const tag = yield* describeDBInstances({
            DBInstanceIdentifier: NONEXISTENT_INSTANCE_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("DBInstanceNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/endpoints") {
          // Listing the account's cluster endpoints succeeds (possibly
          // empty) — proves the grant and the schema decode.
          const result = yield* describeDBClusterEndpoints();
          return yield* HttpServerResponse.json({
            count: (result.DBClusterEndpoints ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/events") {
          // Listing the account's recent Neptune-plane events succeeds
          // (possibly empty) — proves the grant and the schema decode.
          const result = yield* describeEvents();
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          // Listing the account's cluster snapshots succeeds (possibly
          // empty) — proves the grant and the schema decode.
          const result = yield* describeDBClusterSnapshots();
          return yield* HttpServerResponse.json({
            count: (result.DBClusterSnapshots ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/delete-snapshot-probe") {
          // Deleting a nonexistent snapshot must surface the typed
          // not-found tag — proves the write-side grant without ever
          // creating a snapshot.
          const tag = yield* deleteDBClusterSnapshot({
            DBClusterSnapshotIdentifier: NONEXISTENT_SNAPSHOT_ID,
          }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag("DBClusterSnapshotNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/copy-snapshot-probe") {
          // Copying from a nonexistent source snapshot must surface the
          // typed not-found tag — proves the copy grant at zero cost.
          const tag = yield* copyDBClusterSnapshot({
            SourceDBClusterSnapshotIdentifier: NONEXISTENT_SNAPSHOT_ID,
            TargetDBClusterSnapshotIdentifier: `${NONEXISTENT_SNAPSHOT_ID}-copy`,
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catchTag("DBClusterSnapshotNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/pending-maintenance") {
          // Listing pending maintenance actions succeeds (possibly empty).
          const result = yield* describePendingMaintenanceActions();
          return yield* HttpServerResponse.json({
            count: (result.PendingMaintenanceActions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/apply-probe") {
          // Applying maintenance to a nonexistent resource ARN must surface
          // the typed ResourceNotFoundFault — proves the apply grant.
          const arn = url.searchParams.get("arn") ?? "";
          const tag = yield* applyPendingMaintenanceAction({
            ResourceIdentifier: arn,
            ApplyAction: "system-update",
            OptInType: "next-maintenance",
          }).pipe(
            Effect.map(() => "Applied"),
            Effect.catchTag("ResourceNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
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
        Neptune.DescribeDBClustersHttp,
        Neptune.DescribeDBInstancesHttp,
        Neptune.DescribeDBClusterEndpointsHttp,
        Neptune.DescribeEventsHttp,
        Neptune.DescribeDBClusterSnapshotsHttp,
        Neptune.DeleteDBClusterSnapshotHttp,
        Neptune.CopyDBClusterSnapshotHttp,
        Neptune.DescribePendingMaintenanceActionsHttp,
        Neptune.ApplyPendingMaintenanceActionHttp,
      ),
    ),
  ),
);
