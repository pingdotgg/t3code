import * as Lambda from "@/AWS/Lambda";
import * as Redshift from "@/AWS/Redshift";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// Well-formed-but-nonexistent identifiers — the probe routes drive the
// bindings against them so the fixture exercises the IAM grants and the
// typed error decode at zero cost (no cluster/snapshot is ever created).
const NONEXISTENT_CLUSTER_ID = "alchemy-nonexistent-redshift-probe";
const NONEXISTENT_SNAPSHOT_ID = "alchemy-nonexistent-redshift-snapshot-probe";

export class RedshiftBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "RedshiftBindingsTestFunction",
) {}

/**
 * Account-level binding fixture: no Redshift cluster is ever created. List
 * routes prove each grant and response decode against real (possibly empty)
 * account data; probe routes drive identifier-addressed operations against
 * nonexistent identifiers and must surface the service's typed not-found
 * tag — an IAM gap would surface AccessDeniedException and fail the route
 * with an opaque 500.
 *
 * The cluster-scoped bindings (`PauseCluster`, `ResumeCluster`,
 * `RebootCluster`, `CreateClusterSnapshot`) resolve a bound {@link
 * Redshift.Cluster} at deploy time, so they need a live cluster (~5-10 min,
 * billed hourly) and are exercised only under AWS_TEST_REDSHIFT-gated
 * lifecycle runs; they share the same `makeRedshiftClusterHttpBinding`
 * scaffold the account-level routes prove here.
 */
export default RedshiftBindingsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const describeClusters = yield* Redshift.DescribeClusters();
    const describeClusterSnapshots = yield* Redshift.DescribeClusterSnapshots();
    const describeEvents = yield* Redshift.DescribeEvents();
    const deleteClusterSnapshot = yield* Redshift.DeleteClusterSnapshot();
    const copyClusterSnapshot = yield* Redshift.CopyClusterSnapshot();

    const bound = {
      describeClusters,
      describeClusterSnapshots,
      describeEvents,
      deleteClusterSnapshot,
      copyClusterSnapshot,
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
          const tag = yield* describeClusters({
            ClusterIdentifier: NONEXISTENT_CLUSTER_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ClusterNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          // Listing the account's manual snapshots succeeds (possibly
          // empty) — proves the grant and the schema decode.
          const result = yield* describeClusterSnapshots({
            SnapshotType: "manual",
          });
          return yield* HttpServerResponse.json({
            count: (result.Snapshots ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/events") {
          // Listing the account's recent Redshift events succeeds (possibly
          // empty) — proves the grant and the schema decode.
          const result = yield* describeEvents({ Duration: 60 });
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/delete-snapshot-probe") {
          // Deleting a nonexistent snapshot must surface the typed
          // not-found tag — proves the write-side grant without ever
          // creating a snapshot.
          const tag = yield* deleteClusterSnapshot({
            SnapshotIdentifier: NONEXISTENT_SNAPSHOT_ID,
          }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag("ClusterSnapshotNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/copy-snapshot-probe") {
          // Copying from a nonexistent source snapshot must surface the
          // typed not-found tag — proves the copy grant at zero cost.
          const tag = yield* copyClusterSnapshot({
            SourceSnapshotIdentifier: NONEXISTENT_SNAPSHOT_ID,
            TargetSnapshotIdentifier: `${NONEXISTENT_SNAPSHOT_ID}-copy`,
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catchTag("ClusterSnapshotNotFoundFault", (e) =>
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
        Redshift.DescribeClustersHttp,
        Redshift.DescribeClusterSnapshotsHttp,
        Redshift.DescribeEventsHttp,
        Redshift.DeleteClusterSnapshotHttp,
        Redshift.CopyClusterSnapshotHttp,
      ),
    ),
  ),
);
