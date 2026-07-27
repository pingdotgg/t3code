import * as Lambda from "@/AWS/Lambda";
import * as RedshiftServerless from "@/AWS/RedshiftServerless";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "snapshot-handler.ts");

export class SnapshotFunction extends Lambda.Function<Lambda.Function>()(
  "SnapshotFunction",
) {}

/**
 * Exercises the snapshot/recovery-point bindings against a namespace only —
 * no workgroup, so the fixture carries no RPU billing floor.
 */
export default SnapshotFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const namespace = yield* RedshiftServerless.Namespace("SnapshotNamespace", {
      namespaceName: "alchemy-test-rssnap-ns",
      dbName: "dev",
      adminUsername: "alchemyadmin",
      manageAdminPassword: true,
    });

    const NamespaceName = yield* namespace.namespaceName;
    const createSnapshot = yield* RedshiftServerless.CreateSnapshot(namespace);
    const getSnapshot = yield* RedshiftServerless.GetSnapshot();
    const listSnapshots = yield* RedshiftServerless.ListSnapshots();
    const updateSnapshot = yield* RedshiftServerless.UpdateSnapshot();
    const deleteSnapshot = yield* RedshiftServerless.DeleteSnapshot();
    const listRecoveryPoints = yield* RedshiftServerless.ListRecoveryPoints();
    const listTableRestoreStatus =
      yield* RedshiftServerless.ListTableRestoreStatus();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const name = url.searchParams.get("name") ?? "";

        if (request.method === "POST" && pathname === "/snapshot") {
          const { snapshot } = yield* createSnapshot({
            snapshotName: name,
            retentionPeriod: 1,
          });
          return yield* HttpServerResponse.json({
            snapshotName: snapshot?.snapshotName,
            status: snapshot?.status,
          });
        }

        if (request.method === "GET" && pathname === "/snapshot") {
          const { snapshot } = yield* getSnapshot({ snapshotName: name });
          return yield* HttpServerResponse.json({
            snapshotName: snapshot?.snapshotName,
            namespaceName: snapshot?.namespaceName,
            retentionPeriod: snapshot?.snapshotRetentionPeriod,
            status: snapshot?.status,
          });
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          const namespaceName = yield* NamespaceName;
          const { snapshots } = yield* listSnapshots({ namespaceName });
          return yield* HttpServerResponse.json({
            names: (snapshots ?? []).map((s) => s.snapshotName),
          });
        }

        if (request.method === "POST" && pathname === "/snapshot/retention") {
          const { snapshot } = yield* updateSnapshot({
            snapshotName: name,
            retentionPeriod: 2,
          });
          return yield* HttpServerResponse.json({
            retentionPeriod: snapshot?.snapshotRetentionPeriod,
          });
        }

        if (request.method === "DELETE" && pathname === "/snapshot") {
          yield* deleteSnapshot({ snapshotName: name });
          return yield* HttpServerResponse.json({ deleted: true });
        }

        if (request.method === "GET" && pathname === "/recovery-points") {
          const namespaceName = yield* NamespaceName;
          const { recoveryPoints } = yield* listRecoveryPoints({
            namespaceName,
          });
          return yield* HttpServerResponse.json({
            count: (recoveryPoints ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/table-restores") {
          const namespaceName = yield* NamespaceName;
          const { tableRestoreStatuses } = yield* listTableRestoreStatus({
            namespaceName,
          });
          return yield* HttpServerResponse.json({
            count: (tableRestoreStatuses ?? []).length,
          });
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
        RedshiftServerless.CreateSnapshotHttp,
        RedshiftServerless.GetSnapshotHttp,
        RedshiftServerless.ListSnapshotsHttp,
        RedshiftServerless.UpdateSnapshotHttp,
        RedshiftServerless.DeleteSnapshotHttp,
        RedshiftServerless.ListRecoveryPointsHttp,
        RedshiftServerless.ListTableRestoreStatusHttp,
      ),
    ),
  ),
);
