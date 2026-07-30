import * as Backup from "@/AWS/Backup";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic fixture names — distinct from the lifecycle suite's vault so
// the two test files stay quota- and state-independent.
export const FIXTURE_VAULT_NAME = "alchemy-test-backup-bindings-vault";

// Well-formed-but-nonexistent identifiers used to drive typed error paths.
// An IAM gap would surface AccessDeniedException (a 500 through the
// handler's orDie), so a typed not-found tag proves the grant end-to-end.
const BOGUS_JOB_ID = "00000000-0000-0000-0000-000000000000";
const BOGUS_RECOVERY_POINT_ARN =
  "arn:aws:ec2:us-east-1::snapshot/snap-00000000000000000";

export class BackupTestFunction extends Lambda.Function<Lambda.Function>()(
  "BackupTestFunction",
) {}

export default BackupTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const vault = yield* Backup.BackupVault("BindingsVault", {
      backupVaultName: FIXTURE_VAULT_NAME,
    });
    // The role AWS Backup assumes for backup/copy/restore jobs started by
    // the runtime bindings.
    const backupRole = yield* IAM.Role("BindingsBackupRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "backup.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
        "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
      ],
    });

    // --- vault-scoped bindings ---
    const listRecoveryPointsByBackupVault =
      yield* Backup.ListRecoveryPointsByBackupVault(vault);
    const describeRecoveryPoint = yield* Backup.DescribeRecoveryPoint(vault);
    const getRecoveryPointRestoreMetadata =
      yield* Backup.GetRecoveryPointRestoreMetadata(vault);
    // Bound (compile + IAM coverage) but not routed: needs a live recovery
    // point to delete deterministically.
    const deleteRecoveryPoint = yield* Backup.DeleteRecoveryPoint(vault);

    // --- job-start bindings (vault/role injection) ---
    // Bound but not routed to a live start: an on-demand job takes minutes
    // and burns storage; StartRestoreJob is driven through its typed
    // not-found path instead.
    const startBackupJob = yield* Backup.StartBackupJob(vault, backupRole);
    const startCopyJob = yield* Backup.StartCopyJob(vault, backupRole);
    const startRestoreJob = yield* Backup.StartRestoreJob(backupRole);

    // --- account-level bindings ---
    const describeBackupJob = yield* Backup.DescribeBackupJob();
    const listBackupJobs = yield* Backup.ListBackupJobs();
    const stopBackupJob = yield* Backup.StopBackupJob();
    const describeRestoreJob = yield* Backup.DescribeRestoreJob();
    const listRestoreJobs = yield* Backup.ListRestoreJobs();
    // Restore-testing validation flow — the canonical Backup runtime use:
    // AWS invokes a validation Lambda after a restore test; it inspects the
    // restored resource and reports the verdict.
    const getRestoreJobMetadata = yield* Backup.GetRestoreJobMetadata();
    const putRestoreValidationResult =
      yield* Backup.PutRestoreValidationResult();
    const describeCopyJob = yield* Backup.DescribeCopyJob();
    const listCopyJobs = yield* Backup.ListCopyJobs();
    const listProtectedResources = yield* Backup.ListProtectedResources();
    const describeProtectedResource = yield* Backup.DescribeProtectedResource();
    const getSupportedResourceTypes = yield* Backup.GetSupportedResourceTypes();
    const listRecoveryPointsByResource =
      yield* Backup.ListRecoveryPointsByResource();

    // --- event source ---
    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.backup) targeting this Function. Runtime firing needs a real
    // backup job, so the test only verifies the subscription deploys.
    yield* Backup.consumeBackupEvents(
      { kinds: ["backup-job", "restore-job"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`backup event: ${event.detail.state}`),
        ),
    );

    const bound = {
      listRecoveryPointsByBackupVault,
      describeRecoveryPoint,
      deleteRecoveryPoint,
      getRecoveryPointRestoreMetadata,
      startBackupJob,
      startCopyJob,
      startRestoreJob,
      describeBackupJob,
      listBackupJobs,
      stopBackupJob,
      describeRestoreJob,
      listRestoreJobs,
      getRestoreJobMetadata,
      putRestoreValidationResult,
      describeCopyJob,
      listCopyJobs,
      listProtectedResources,
      describeProtectedResource,
      getSupportedResourceTypes,
      listRecoveryPointsByResource,
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

        if (request.method === "GET" && pathname === "/list-recovery-points") {
          const result = yield* listRecoveryPointsByBackupVault({
            MaxResults: 25,
          });
          return yield* HttpServerResponse.json({
            count: (result.RecoveryPoints ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/list-backup-jobs") {
          const result = yield* listBackupJobs({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (result.BackupJobs ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/list-restore-jobs") {
          const result = yield* listRestoreJobs({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (result.RestoreJobs ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/list-copy-jobs") {
          const result = yield* listCopyJobs({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (result.CopyJobs ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/list-protected-resources"
        ) {
          const result = yield* listProtectedResources({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (result.Results ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/supported-resource-types"
        ) {
          const result = yield* getSupportedResourceTypes();
          return yield* HttpServerResponse.json({
            resourceTypes: result.ResourceTypes ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/describe-backup-job-not-found"
        ) {
          // Exercises the typed not-found error path end-to-end.
          const result = yield* describeBackupJob({
            BackupJobId: BOGUS_JOB_ID,
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterValueException"],
              () => Effect.succeed({ found: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/describe-recovery-point-not-found"
        ) {
          // Exercises BackupVaultName injection + the typed not-found path.
          const result = yield* describeRecoveryPoint({
            RecoveryPointArn: BOGUS_RECOVERY_POINT_ARN,
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterValueException"],
              () => Effect.succeed({ found: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/restore-metadata-not-found"
        ) {
          const result = yield* getRecoveryPointRestoreMetadata({
            RecoveryPointArn: BOGUS_RECOVERY_POINT_ARN,
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterValueException"],
              () => Effect.succeed({ found: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/restore-job-metadata-not-found"
        ) {
          const result = yield* getRestoreJobMetadata({
            RestoreJobId: BOGUS_JOB_ID,
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterValueException"],
              () => Effect.succeed({ found: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "POST" &&
          pathname === "/put-restore-validation-not-found"
        ) {
          // A verdict can only be posted against a live restore-test job;
          // drive the binding through its typed error path instead — an IAM
          // gap would surface AccessDeniedException (500), not a typed tag.
          const tag = yield* putRestoreValidationResult({
            RestoreJobId: BOGUS_JOB_ID,
            ValidationStatus: "SUCCESSFUL",
          }).pipe(
            Effect.map(() => "Accepted"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterValueException",
                "MissingParameterValueException",
                "InvalidRequestException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/stop-backup-job-not-found"
        ) {
          const tag = yield* stopBackupJob({ BackupJobId: BOGUS_JOB_ID }).pipe(
            Effect.map(() => "Stopped"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterValueException",
                "InvalidRequestException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/start-restore-not-found"
        ) {
          // A real restore needs a live recovery point; drive the binding
          // (role injection + IAM grant) through its typed error path — an
          // IAM gap would surface AccessDeniedException (500) instead.
          const tag = yield* startRestoreJob({
            RecoveryPointArn: BOGUS_RECOVERY_POINT_ARN,
            Metadata: {},
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterValueException",
                "MissingParameterValueException",
                "InvalidRequestException",
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
        Lambda.EventSource,
        Backup.ListRecoveryPointsByBackupVaultHttp,
        Backup.DescribeRecoveryPointHttp,
        Backup.DeleteRecoveryPointHttp,
        Backup.GetRecoveryPointRestoreMetadataHttp,
        Backup.StartBackupJobHttp,
        Backup.StartCopyJobHttp,
        Backup.StartRestoreJobHttp,
        Backup.DescribeBackupJobHttp,
        Backup.ListBackupJobsHttp,
        Backup.StopBackupJobHttp,
        Backup.DescribeRestoreJobHttp,
        Backup.ListRestoreJobsHttp,
        Backup.GetRestoreJobMetadataHttp,
        Backup.PutRestoreValidationResultHttp,
        Backup.DescribeCopyJobHttp,
        Backup.ListCopyJobsHttp,
        Backup.ListProtectedResourcesHttp,
        Backup.DescribeProtectedResourceHttp,
        Backup.GetSupportedResourceTypesHttp,
        Backup.ListRecoveryPointsByResourceHttp,
      ),
    ),
  ),
);
