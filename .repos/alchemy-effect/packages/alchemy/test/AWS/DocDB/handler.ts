import * as DocDB from "@/AWS/DocDB";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed-but-nonexistent identifiers — the probe routes drive the
// bindings against them so the fixture exercises the IAM grants and the
// typed error decode at zero cost (no cluster/snapshot is ever created).
const NONEXISTENT_CLUSTER_ID = "alchemy-nonexistent-docdb-probe";
const NONEXISTENT_INSTANCE_ID = "alchemy-nonexistent-docdb-instance-probe";
const NONEXISTENT_SNAPSHOT_ID = "alchemy-nonexistent-docdb-snapshot-probe";

// The DocDB barrel re-exports the mongo Effect client; if tree-shaking
// retains it, the mongodb driver's optional companion packages must stay
// external (they are `require`d in try/catch fallbacks).
const MONGODB_OPTIONAL_DEPS = [
  "kerberos",
  "@mongodb-js/zstd",
  "@aws-sdk/credential-providers",
  "gcp-metadata",
  "snappy",
  "socks",
  "aws4",
  "mongodb-client-encryption",
];

export class DocDBTestFunction extends Lambda.Function<Lambda.Function>()(
  "DocDBTestFunction",
) {}

export default DocDBTestFunction.make(
  {
    main,
    url: true,
    build: { external: MONGODB_OPTIONAL_DEPS },
  },
  Effect.gen(function* () {
    const describeDBClusters = yield* DocDB.DescribeDBClusters();
    const describeDBInstances = yield* DocDB.DescribeDBInstances();
    const describeEvents = yield* DocDB.DescribeEvents();
    const describeDBClusterSnapshots =
      yield* DocDB.DescribeDBClusterSnapshots();
    const deleteDBClusterSnapshot = yield* DocDB.DeleteDBClusterSnapshot();
    const copyDBClusterSnapshot = yield* DocDB.CopyDBClusterSnapshot();
    const describePendingMaintenanceActions =
      yield* DocDB.DescribePendingMaintenanceActions();
    const applyPendingMaintenanceAction =
      yield* DocDB.ApplyPendingMaintenanceAction();

    const bound = {
      describeDBClusters,
      describeDBInstances,
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

        if (request.method === "GET" && pathname === "/events") {
          // Listing the account's recent DocumentDB events succeeds
          // (possibly empty) — proves the grant and the schema decode.
          const result = yield* describeEvents();
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
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
        DocDB.DescribeDBClustersHttp,
        DocDB.DescribeDBInstancesHttp,
        DocDB.DescribeEventsHttp,
        DocDB.DescribeDBClusterSnapshotsHttp,
        DocDB.DeleteDBClusterSnapshotHttp,
        DocDB.CopyDBClusterSnapshotHttp,
        DocDB.DescribePendingMaintenanceActionsHttp,
        DocDB.ApplyPendingMaintenanceActionHttp,
      ),
    ),
  ),
);
