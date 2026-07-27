import * as DocDBElastic from "@/AWS/DocDBElastic";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class DocDBElasticTestFunction extends Lambda.Function<Lambda.Function>()(
  "DocDBElasticTestFunction",
) {}

/**
 * Account-level binding fixture: no elastic cluster is ever created. List
 * routes prove each grant and response decode against real (possibly empty)
 * account data; probe routes drive ARN-addressed operations against
 * well-formed-but-nonexistent ARNs (passed by the test as a query parameter)
 * and must surface the service's typed not-found tag — an IAM gap would
 * surface AccessDeniedException and fail the route with an opaque 500.
 */
export default DocDBElasticTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const listSnapshots = yield* DocDBElastic.ListClusterSnapshots();
    const getSnapshot = yield* DocDBElastic.GetClusterSnapshot();
    const deleteSnapshot = yield* DocDBElastic.DeleteClusterSnapshot();
    const copySnapshot = yield* DocDBElastic.CopyClusterSnapshot();
    const restoreCluster = yield* DocDBElastic.RestoreClusterFromSnapshot();
    const listPending = yield* DocDBElastic.ListPendingMaintenanceActions();
    const getPending = yield* DocDBElastic.GetPendingMaintenanceAction();
    const applyPending = yield* DocDBElastic.ApplyPendingMaintenanceAction();

    const bound = {
      listSnapshots,
      getSnapshot,
      deleteSnapshot,
      copySnapshot,
      restoreCluster,
      listPending,
      getPending,
      applyPending,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const arn = url.searchParams.get("arn") ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          const result = yield* listSnapshots();
          return yield* HttpServerResponse.json({
            count: (result.snapshots ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/maintenance") {
          const result = yield* listPending();
          return yield* HttpServerResponse.json({
            count: (result.resourcePendingMaintenanceActions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/snapshot-probe") {
          const tag = yield* getSnapshot({ snapshotArn: arn }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/delete-probe") {
          const tag = yield* deleteSnapshot({ snapshotArn: arn }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/copy-probe") {
          const tag = yield* copySnapshot({
            snapshotArn: arn,
            targetSnapshotName: "alchemy-docdb-elastic-copy-probe",
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/restore-probe") {
          const tag = yield* restoreCluster({
            snapshotArn: arn,
            clusterName: "alchemy-docdb-elastic-restore-probe",
          }).pipe(
            Effect.map(() => "Restored"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/pending-probe") {
          const tag = yield* getPending({ resourceArn: arn }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/apply-probe") {
          const tag = yield* applyPending({
            resourceArn: arn,
            applyAction: "ENGINE_UPDATE",
            optInType: "NEXT_MAINTENANCE",
          }).pipe(
            Effect.map(() => "Applied"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
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
        DocDBElastic.ListClusterSnapshotsHttp,
        DocDBElastic.GetClusterSnapshotHttp,
        DocDBElastic.DeleteClusterSnapshotHttp,
        DocDBElastic.CopyClusterSnapshotHttp,
        DocDBElastic.RestoreClusterFromSnapshotHttp,
        DocDBElastic.ListPendingMaintenanceActionsHttp,
        DocDBElastic.GetPendingMaintenanceActionHttp,
        DocDBElastic.ApplyPendingMaintenanceActionHttp,
      ),
    ),
  ),
);
