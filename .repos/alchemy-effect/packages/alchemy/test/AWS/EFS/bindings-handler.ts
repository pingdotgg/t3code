import * as EFS from "@/AWS/EFS";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// Deterministic idempotency token for the runtime create/delete round-trip.
const ACCESS_POINT_CLIENT_TOKEN = "alchemy-efs-bindings-access-point";

export class EfsBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "EfsBindingsFunction",
) {}

export default EfsBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Control-plane bindings only — no VPC/mount target needed: EFS's data
    // plane is NFS (covered by the Lambda `fileSystemConfigs` mount), while
    // these bindings drive the management API over HTTPS.
    const files = yield* EFS.FileSystem("BindingsFileSystem");

    const describeFileSystem = yield* EFS.DescribeFileSystem(files);
    const describeMountTargets = yield* EFS.DescribeMountTargets(files);
    const describeAccessPoints = yield* EFS.DescribeAccessPoints(files);
    const describeBackupPolicy = yield* EFS.DescribeBackupPolicy(files);
    const putBackupPolicy = yield* EFS.PutBackupPolicy(files);
    const describeLifecycleConfiguration =
      yield* EFS.DescribeLifecycleConfiguration(files);
    const putLifecycleConfiguration =
      yield* EFS.PutLifecycleConfiguration(files);
    const createAccessPoint = yield* EFS.CreateAccessPoint(files);
    const deleteAccessPoint = yield* EFS.DeleteAccessPoint();
    const describeReplicationConfigurations =
      yield* EFS.DescribeReplicationConfigurations(files);

    const bound = {
      describeFileSystem,
      describeMountTargets,
      describeAccessPoints,
      describeBackupPolicy,
      putBackupPolicy,
      describeLifecycleConfiguration,
      putLifecycleConfiguration,
      createAccessPoint,
      deleteAccessPoint,
      describeReplicationConfigurations,
    };

    // A put racing a still-transitioning previous change surfaces the typed
    // IncorrectFileSystemLifeCycleState — retry it bounded (~20s).
    const retryWhileUpdating = <A, E extends { _tag: string }, R>(
      self: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.retry(self, {
        while: (e): boolean => e._tag === "IncorrectFileSystemLifeCycleState",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(10),
        ]),
      });

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

        if (request.method === "GET" && pathname === "/file-system") {
          // FileSystemId injection scopes the response to the bound file
          // system.
          const response = yield* describeFileSystem();
          const fs = response.FileSystems?.[0];
          return yield* HttpServerResponse.json({
            fileSystemId: fs?.FileSystemId,
            state: fs?.LifeCycleState,
            encrypted: fs?.Encrypted,
          });
        }

        if (request.method === "GET" && pathname === "/mount-targets") {
          const response = yield* describeMountTargets();
          return yield* HttpServerResponse.json({
            count: (response.MountTargets ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/access-points") {
          const response = yield* describeAccessPoints();
          return yield* HttpServerResponse.json({
            count: (response.AccessPoints ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/backup-policy") {
          // A file system that never had a backup policy fails with the
          // typed PolicyNotFound — normalize it to "NONE".
          const status = yield* describeBackupPolicy().pipe(
            Effect.map((r) => r.BackupPolicy?.Status ?? "NONE"),
            Effect.catchTag("PolicyNotFound", () => Effect.succeed("NONE")),
          );
          return yield* HttpServerResponse.json({ status });
        }

        if (request.method === "POST" && pathname === "/backup-policy/enable") {
          const response = yield* retryWhileUpdating(
            putBackupPolicy({ BackupPolicy: { Status: "ENABLED" } }),
          );
          return yield* HttpServerResponse.json({
            status: response.BackupPolicy?.Status,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/backup-policy/disable"
        ) {
          const response = yield* retryWhileUpdating(
            putBackupPolicy({ BackupPolicy: { Status: "DISABLED" } }),
          );
          return yield* HttpServerResponse.json({
            status: response.BackupPolicy?.Status,
          });
        }

        if (request.method === "GET" && pathname === "/lifecycle") {
          const response = yield* describeLifecycleConfiguration();
          return yield* HttpServerResponse.json({
            count: (response.LifecyclePolicies ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/lifecycle/set") {
          const response = yield* retryWhileUpdating(
            putLifecycleConfiguration({
              LifecyclePolicies: [{ TransitionToIA: "AFTER_30_DAYS" }],
            }),
          );
          return yield* HttpServerResponse.json({
            count: (response.LifecyclePolicies ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/lifecycle/clear") {
          const response = yield* retryWhileUpdating(
            putLifecycleConfiguration({ LifecyclePolicies: [] }),
          );
          return yield* HttpServerResponse.json({
            count: (response.LifecyclePolicies ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/access-point") {
          // Create-then-delete round-trip: exercises the runtime
          // multi-tenant pattern end-to-end and leaves no orphan. A crashed
          // previous invocation surfaces the typed AccessPointAlreadyExists
          // (same client token) — resolve it by describing the winner.
          const accessPoint = yield* createAccessPoint({
            ClientToken: ACCESS_POINT_CLIENT_TOKEN,
            PosixUser: { Uid: 1000, Gid: 1000 },
            RootDirectory: {
              Path: "/bindings-test",
              CreationInfo: {
                OwnerUid: 1000,
                OwnerGid: 1000,
                Permissions: "750",
              },
            },
          }).pipe(
            Effect.catchTag("AccessPointAlreadyExists", () =>
              describeAccessPoints().pipe(
                Effect.map((r) =>
                  r.AccessPoints?.find(
                    (ap) => ap.ClientToken === ACCESS_POINT_CLIENT_TOKEN,
                  )!,
                ),
              ),
            ),
          );
          yield* deleteAccessPoint({
            AccessPointId: accessPoint.AccessPointId!,
          }).pipe(Effect.catchTag("AccessPointNotFound", () => Effect.void));
          return yield* HttpServerResponse.json({
            accessPointId: accessPoint.AccessPointId,
            deleted: true,
          });
        }

        if (request.method === "GET" && pathname === "/replication") {
          // The fixture file system has no replication configuration — the
          // typed ReplicationNotFound proves the grant end-to-end (an IAM
          // gap would surface AccessDeniedException, a 500).
          const hasReplication =
            yield* describeReplicationConfigurations().pipe(
              Effect.map((r) => (r.Replications ?? []).length > 0),
              Effect.catchTag("ReplicationNotFound", () =>
                Effect.succeed(false),
              ),
            );
          return yield* HttpServerResponse.json({ hasReplication });
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
        EFS.DescribeFileSystemHttp,
        EFS.DescribeMountTargetsHttp,
        EFS.DescribeAccessPointsHttp,
        EFS.DescribeBackupPolicyHttp,
        EFS.PutBackupPolicyHttp,
        EFS.DescribeLifecycleConfigurationHttp,
        EFS.PutLifecycleConfigurationHttp,
        EFS.CreateAccessPointHttp,
        EFS.DeleteAccessPointHttp,
        EFS.DescribeReplicationConfigurationsHttp,
      ),
    ),
  ),
);
