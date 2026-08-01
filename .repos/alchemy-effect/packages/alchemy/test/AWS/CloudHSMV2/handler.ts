import * as CloudHSMV2 from "@/AWS/CloudHSMV2";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed-but-nonexistent identifiers — every route drives its binding
// against these so the fixture exercises IAM grants + typed error decoding
// at zero cost (no cluster, no HSM, no backup is ever created).
const NONEXISTENT_CLUSTER_ID = "cluster-aaaaaaaaaaa";
const NONEXISTENT_BACKUP_ID = "backup-aaaaaaaaaaa";

// Placeholder PEM material for InitializeCluster — the nonexistent cluster
// id is rejected before the certificates are parsed.
const PLACEHOLDER_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

export class CloudHSMV2TestFunction extends Lambda.Function<Lambda.Function>()(
  "CloudHSMV2TestFunction",
) {}

export default CloudHSMV2TestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const describeClusters = yield* CloudHSMV2.DescribeClusters();
    const describeBackups = yield* CloudHSMV2.DescribeBackups();
    const deleteBackup = yield* CloudHSMV2.DeleteBackup();
    const restoreBackup = yield* CloudHSMV2.RestoreBackup();
    const modifyBackupAttributes = yield* CloudHSMV2.ModifyBackupAttributes();
    const copyBackupToRegion = yield* CloudHSMV2.CopyBackupToRegion();
    const initializeCluster = yield* CloudHSMV2.InitializeCluster();
    const getResourcePolicy = yield* CloudHSMV2.GetResourcePolicy();
    const putResourcePolicy = yield* CloudHSMV2.PutResourcePolicy();
    const deleteResourcePolicy = yield* CloudHSMV2.DeleteResourcePolicy();

    const bound = {
      describeClusters,
      describeBackups,
      deleteBackup,
      restoreBackup,
      modifyBackupAttributes,
      copyBackupToRegion,
      initializeCluster,
      getResourcePolicy,
      putResourcePolicy,
      deleteResourcePolicy,
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
          // A filter on a nonexistent id yields an empty page — proves the
          // grant and the response schema decode deterministically.
          const result = yield* describeClusters({
            Filters: { clusterIds: [NONEXISTENT_CLUSTER_ID] },
          });
          return yield* HttpServerResponse.json({
            count: (result.Clusters ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/backups") {
          const result = yield* describeBackups({
            Filters: { backupIds: [NONEXISTENT_BACKUP_ID] },
          });
          return yield* HttpServerResponse.json({
            count: (result.Backups ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/backup-delete") {
          // A nonexistent backup id must surface the service's typed
          // not-found tag — an IAM gap would surface AccessDeniedException
          // and fail the route with an opaque 500 instead.
          const tag = yield* deleteBackup({
            BackupId: NONEXISTENT_BACKUP_ID,
          }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catchTag("CloudHsmResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/backup-restore") {
          const tag = yield* restoreBackup({
            BackupId: NONEXISTENT_BACKUP_ID,
          }).pipe(
            Effect.map(() => "Restored"),
            Effect.catchTag("CloudHsmResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/backup-modify") {
          const tag = yield* modifyBackupAttributes({
            BackupId: NONEXISTENT_BACKUP_ID,
            NeverExpires: true,
          }).pipe(
            Effect.map(() => "Modified"),
            Effect.catchTag("CloudHsmResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/backup-copy") {
          const region = yield* Effect.sync(
            () => process.env.AWS_REGION ?? "us-west-2",
          );
          const tag = yield* copyBackupToRegion({
            DestinationRegion:
              region === "us-east-1" ? "us-west-2" : "us-east-1",
            BackupId: NONEXISTENT_BACKUP_ID,
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catchTag(
              [
                "CloudHsmResourceNotFoundException",
                "CloudHsmInvalidRequestException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/cluster-init") {
          const tag = yield* initializeCluster({
            ClusterId: NONEXISTENT_CLUSTER_ID,
            SignedCert: PLACEHOLDER_PEM,
            TrustAnchor: PLACEHOLDER_PEM,
          }).pipe(
            Effect.map(() => "Initialized"),
            Effect.catchTag(
              [
                "CloudHsmResourceNotFoundException",
                "CloudHsmInvalidRequestException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/policy-get") {
          // An empty request fails service-side validation — reaching the
          // service's validator at all proves the IAM grant.
          const tag = yield* getResourcePolicy().pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "CloudHsmInvalidRequestException",
                "CloudHsmResourceNotFoundException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/policy-put") {
          const tag = yield* putResourcePolicy({}).pipe(
            Effect.map(() => "Put"),
            Effect.catchTag(
              [
                "CloudHsmInvalidRequestException",
                "CloudHsmResourceNotFoundException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/policy-delete") {
          const tag = yield* deleteResourcePolicy({}).pipe(
            Effect.map(() => "PolicyDeleted"),
            Effect.catchTag(
              [
                "CloudHsmInvalidRequestException",
                "CloudHsmResourceNotFoundException",
              ],
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
        CloudHSMV2.DescribeClustersHttp,
        CloudHSMV2.DescribeBackupsHttp,
        CloudHSMV2.DeleteBackupHttp,
        CloudHSMV2.RestoreBackupHttp,
        CloudHSMV2.ModifyBackupAttributesHttp,
        CloudHSMV2.CopyBackupToRegionHttp,
        CloudHSMV2.InitializeClusterHttp,
        CloudHSMV2.GetResourcePolicyHttp,
        CloudHSMV2.PutResourcePolicyHttp,
        CloudHSMV2.DeleteResourcePolicyHttp,
      ),
    ),
  ),
);
