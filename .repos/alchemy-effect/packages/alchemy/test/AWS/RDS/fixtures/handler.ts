import * as Lambda from "@/AWS/Lambda";
import * as RDS from "@/AWS/RDS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed-but-nonexistent identifiers — the probe routes drive the
// bindings against them so the fixture exercises the IAM grants and the
// typed error decode at zero cost (no database/snapshot is ever created).
const NONEXISTENT_CLUSTER_ID = "alchemy-nonexistent-rds-cluster-probe";
const NONEXISTENT_INSTANCE_ID = "alchemy-nonexistent-rds-instance-probe";
const NONEXISTENT_CLUSTER_SNAPSHOT_ID =
  "alchemy-nonexistent-rds-cluster-snapshot-probe";
const NONEXISTENT_SNAPSHOT_ID = "alchemy-nonexistent-rds-snapshot-probe";

export class RdsBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "RdsBindingsTestFunction",
) {}

/**
 * Account-level binding fixture: no RDS database is ever created. List
 * routes prove each grant and response decode against real (possibly
 * empty) account data; probe routes drive identifier-addressed operations
 * against nonexistent identifiers and must surface the service's typed
 * not-found tag — an IAM gap would surface AccessDeniedException and fail
 * the route with an opaque 500.
 *
 * The cluster/instance-scoped bindings (`CreateDBClusterSnapshot`,
 * `CreateDBSnapshot`, `FailoverDBCluster`, `Start/StopDBCluster`,
 * `Start/Stop/RebootDBInstance`) resolve a bound resource at deploy time,
 * so they need a live database (~10 min, billed hourly) and are exercised
 * only under RDS_TEST_LIFECYCLE-gated runs.
 */
export default RdsBindingsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const describeDBClusters = yield* RDS.DescribeDBClusters();
    const describeDBInstances = yield* RDS.DescribeDBInstances();
    const describeDBClusterEndpoints = yield* RDS.DescribeDBClusterEndpoints();
    const describeEvents = yield* RDS.DescribeEvents();
    const describeDBClusterSnapshots = yield* RDS.DescribeDBClusterSnapshots();
    const describeDBSnapshots = yield* RDS.DescribeDBSnapshots();
    const deleteDBClusterSnapshot = yield* RDS.DeleteDBClusterSnapshot();
    const copyDBClusterSnapshot = yield* RDS.CopyDBClusterSnapshot();
    const deleteDBSnapshot = yield* RDS.DeleteDBSnapshot();
    const copyDBSnapshot = yield* RDS.CopyDBSnapshot();
    const describePendingMaintenanceActions =
      yield* RDS.DescribePendingMaintenanceActions();
    const applyPendingMaintenanceAction =
      yield* RDS.ApplyPendingMaintenanceAction();

    const bound = {
      describeDBClusters,
      describeDBInstances,
      describeDBClusterEndpoints,
      describeEvents,
      describeDBClusterSnapshots,
      describeDBSnapshots,
      deleteDBClusterSnapshot,
      copyDBClusterSnapshot,
      deleteDBSnapshot,
      copyDBSnapshot,
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
          // typed not-found tag.
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
          // Listing the account's recent RDS events succeeds (possibly
          // empty) — proves the grant and the schema decode.
          const result = yield* describeEvents();
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/cluster-snapshots") {
          // Listing the account's cluster snapshots succeeds (possibly
          // empty).
          const result = yield* describeDBClusterSnapshots();
          return yield* HttpServerResponse.json({
            count: (result.DBClusterSnapshots ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/instance-snapshots") {
          // Listing the account's instance snapshots succeeds (possibly
          // empty).
          const result = yield* describeDBSnapshots();
          return yield* HttpServerResponse.json({
            count: (result.DBSnapshots ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/delete-cluster-snapshot-probe"
        ) {
          // Deleting a nonexistent cluster snapshot must surface the typed
          // not-found tag — proves the write-side grant without ever
          // creating a snapshot.
          const tag = yield* deleteDBClusterSnapshot({
            DBClusterSnapshotIdentifier: NONEXISTENT_CLUSTER_SNAPSHOT_ID,
          }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag("DBClusterSnapshotNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/copy-cluster-snapshot-probe"
        ) {
          // Copying from a nonexistent source snapshot must surface the
          // typed not-found tag — proves the copy grant at zero cost.
          const tag = yield* copyDBClusterSnapshot({
            SourceDBClusterSnapshotIdentifier: NONEXISTENT_CLUSTER_SNAPSHOT_ID,
            TargetDBClusterSnapshotIdentifier: `${NONEXISTENT_CLUSTER_SNAPSHOT_ID}-copy`,
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catchTag("DBClusterSnapshotNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/delete-instance-snapshot-probe"
        ) {
          // Deleting a nonexistent instance snapshot must surface the
          // typed not-found tag.
          const tag = yield* deleteDBSnapshot({
            DBSnapshotIdentifier: NONEXISTENT_SNAPSHOT_ID,
          }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag("DBSnapshotNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/copy-instance-snapshot-probe"
        ) {
          // Copying from a nonexistent source snapshot must surface the
          // typed not-found tag.
          const tag = yield* copyDBSnapshot({
            SourceDBSnapshotIdentifier: NONEXISTENT_SNAPSHOT_ID,
            TargetDBSnapshotIdentifier: `${NONEXISTENT_SNAPSHOT_ID}-copy`,
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catchTag("DBSnapshotNotFoundFault", (e) =>
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
        RDS.DescribeDBClustersHttp,
        RDS.DescribeDBInstancesHttp,
        RDS.DescribeDBClusterEndpointsHttp,
        RDS.DescribeEventsHttp,
        RDS.DescribeDBClusterSnapshotsHttp,
        RDS.DescribeDBSnapshotsHttp,
        RDS.DeleteDBClusterSnapshotHttp,
        RDS.CopyDBClusterSnapshotHttp,
        RDS.DeleteDBSnapshotHttp,
        RDS.CopyDBSnapshotHttp,
        RDS.DescribePendingMaintenanceActionsHttp,
        RDS.ApplyPendingMaintenanceActionHttp,
      ),
    ),
  ),
);
