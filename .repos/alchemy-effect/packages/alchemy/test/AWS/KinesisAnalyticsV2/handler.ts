import * as KinesisAnalyticsV2 from "@/AWS/KinesisAnalyticsV2";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Deterministic out-of-band code bucket, provisioned by the test's
 * `beforeAll` (see code-bucket.ts) BEFORE the stack deploys — the service
 * reads the code object at application-create time.
 */
export const FIXTURE_CODE_BUCKET = "alchemy-test-kav2-bindings-code";
/** Must match `codeKey` in code-bucket.ts. */
const FIXTURE_CODE_KEY = "code/app.zip";

export class KinesisAnalyticsV2TestFunction extends Lambda.Function<Lambda.Function>()(
  "KinesisAnalyticsV2TestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts the tag is a typed,
 * non-authorization tag, which proves both the binding wiring and the IAM
 * grant. An untyped error crashes into a 500 instead.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

export default KinesisAnalyticsV2TestFunction.make(
  {
    main,
    url: true,
    // Application probes fan out SDK calls — AWS's 3s default intermittently
    // times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The application never starts (the staged zip is a placeholder, not a
    // real Flink jar) — it stays READY, so every route below either reads
    // harmlessly or drives a typed service-side rejection.
    const app = yield* KinesisAnalyticsV2.Application("BindingsApp", {
      runtimeEnvironment: "FLINK-1_20",
      code: {
        bucketArn: `arn:aws:s3:::${FIXTURE_CODE_BUCKET}`,
        fileKey: FIXTURE_CODE_KEY,
      },
      snapshotsEnabled: true,
    });

    const describeApplication =
      yield* KinesisAnalyticsV2.DescribeApplication(app);
    const describeApplicationVersion =
      yield* KinesisAnalyticsV2.DescribeApplicationVersion(app);
    const listApplicationVersions =
      yield* KinesisAnalyticsV2.ListApplicationVersions(app);
    const describeApplicationOperation =
      yield* KinesisAnalyticsV2.DescribeApplicationOperation(app);
    const listApplicationOperations =
      yield* KinesisAnalyticsV2.ListApplicationOperations(app);
    const startApplication = yield* KinesisAnalyticsV2.StartApplication(app);
    const stopApplication = yield* KinesisAnalyticsV2.StopApplication(app);
    const rollbackApplication =
      yield* KinesisAnalyticsV2.RollbackApplication(app);
    const createApplicationSnapshot =
      yield* KinesisAnalyticsV2.CreateApplicationSnapshot(app);
    const describeApplicationSnapshot =
      yield* KinesisAnalyticsV2.DescribeApplicationSnapshot(app);
    const listApplicationSnapshots =
      yield* KinesisAnalyticsV2.ListApplicationSnapshots(app);
    const deleteApplicationSnapshot =
      yield* KinesisAnalyticsV2.DeleteApplicationSnapshot(app);
    const createApplicationPresignedUrl =
      yield* KinesisAnalyticsV2.CreateApplicationPresignedUrl(app);
    // Account-level binding — takes no resource argument.
    const listApplications = yield* KinesisAnalyticsV2.ListApplications();

    const bound = {
      describeApplication,
      describeApplicationVersion,
      listApplicationVersions,
      describeApplicationOperation,
      listApplicationOperations,
      startApplication,
      stopApplication,
      rollbackApplication,
      createApplicationSnapshot,
      describeApplicationSnapshot,
      listApplicationSnapshots,
      deleteApplicationSnapshot,
      createApplicationPresignedUrl,
      listApplications,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const route = `${request.method} ${url.pathname}`;

        switch (route) {
          case "GET /bindings":
            return yield* HttpServerResponse.json({
              bound: Object.keys(bound),
            });

          case "GET /describe": {
            const result = yield* errorTagged(describeApplication());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    status: result.ApplicationDetail.ApplicationStatus,
                    runtime: result.ApplicationDetail.RuntimeEnvironment,
                    name: result.ApplicationDetail.ApplicationName,
                  },
            );
          }

          case "GET /applications": {
            // Self-verifying: the account list must contain the bound
            // application (looked up by name via the describe binding).
            const result = yield* errorTagged(
              Effect.gen(function* () {
                const { ApplicationDetail } = yield* describeApplication();
                const listed = yield* listApplications({ Limit: 50 });
                return {
                  count: (listed.ApplicationSummaries ?? []).length,
                  containsSelf: (listed.ApplicationSummaries ?? []).some(
                    (summary) =>
                      summary.ApplicationName ===
                      ApplicationDetail.ApplicationName,
                  ),
                };
              }),
            );
            return yield* HttpServerResponse.json(result);
          }

          case "GET /versions": {
            const result = yield* errorTagged(listApplicationVersions());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.ApplicationVersionSummaries ?? []).length },
            );
          }

          case "GET /version": {
            const result = yield* errorTagged(
              describeApplicationVersion({ ApplicationVersionId: 1 }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    versionId:
                      result.ApplicationVersionDetail?.ApplicationVersionId,
                  },
            );
          }

          case "GET /operations": {
            const result = yield* errorTagged(listApplicationOperations());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.ApplicationOperationInfoList ?? []).length },
            );
          }

          case "GET /operation": {
            // A well-formed-but-nonexistent operation id — an IAM gap would
            // surface AccessDeniedException (an opaque 500) instead of the
            // typed rejection.
            const result = yield* errorTagged(
              describeApplicationOperation({
                OperationId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          case "GET /snapshots": {
            const result = yield* errorTagged(listApplicationSnapshots());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.SnapshotSummaries ?? []).length },
            );
          }

          case "GET /snapshot": {
            const result = yield* errorTagged(
              describeApplicationSnapshot({ SnapshotName: "does-not-exist" }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          case "POST /snapshot/create": {
            // The application is READY (not RUNNING) — the service rejects
            // the snapshot with a typed error, proving the grant without
            // mutating anything.
            const result = yield* errorTagged(
              createApplicationSnapshot({ SnapshotName: "bindings-probe" }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          case "POST /snapshot/delete": {
            const result = yield* errorTagged(
              deleteApplicationSnapshot({
                SnapshotName: "does-not-exist",
                SnapshotCreationTimestamp: new Date(0),
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          case "GET /presigned-url": {
            const result = yield* errorTagged(
              createApplicationPresignedUrl({
                UrlType: "FLINK_DASHBOARD_URL",
                SessionExpirationDurationInSeconds: 1800,
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { hasUrl: typeof result.AuthorizedUrl === "string" },
            );
          }

          case "POST /rollback": {
            // A READY application has nothing to roll back — typed rejection
            // proves the grant.
            const result = yield* errorTagged(
              Effect.gen(function* () {
                const { ApplicationDetail } = yield* describeApplication();
                return yield* rollbackApplication({
                  CurrentApplicationVersionId:
                    ApplicationDetail.ApplicationVersionId,
                });
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          case "POST /stop": {
            // Force-stopping a READY application is a typed no-op rejection.
            const result = yield* errorTagged(stopApplication({ Force: true }));
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          case "POST /start": {
            // Restoring from a nonexistent custom snapshot rejects before
            // the placeholder zip ever runs. If the service accepts the
            // start anyway, force-stop immediately so the fixture returns
            // to READY for teardown.
            const result = yield* errorTagged(
              startApplication({
                RunConfiguration: {
                  ApplicationRestoreConfiguration: {
                    ApplicationRestoreType: "RESTORE_FROM_CUSTOM_SNAPSHOT",
                    SnapshotName: "does-not-exist",
                  },
                },
              }),
            );
            if ("errorTag" in result) {
              return yield* HttpServerResponse.json(result);
            }
            yield* errorTagged(stopApplication({ Force: true }));
            return yield* HttpServerResponse.json({
              started: true,
              stopped: true,
            });
          }

          default:
            return yield* HttpServerResponse.json(
              { error: "Not found", route },
              { status: 404 },
            );
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        KinesisAnalyticsV2.DescribeApplicationHttp,
        KinesisAnalyticsV2.DescribeApplicationVersionHttp,
        KinesisAnalyticsV2.ListApplicationVersionsHttp,
        KinesisAnalyticsV2.DescribeApplicationOperationHttp,
        KinesisAnalyticsV2.ListApplicationOperationsHttp,
        KinesisAnalyticsV2.StartApplicationHttp,
        KinesisAnalyticsV2.StopApplicationHttp,
        KinesisAnalyticsV2.RollbackApplicationHttp,
        KinesisAnalyticsV2.CreateApplicationSnapshotHttp,
        KinesisAnalyticsV2.DescribeApplicationSnapshotHttp,
        KinesisAnalyticsV2.ListApplicationSnapshotsHttp,
        KinesisAnalyticsV2.DeleteApplicationSnapshotHttp,
        KinesisAnalyticsV2.CreateApplicationPresignedUrlHttp,
        KinesisAnalyticsV2.ListApplicationsHttp,
      ),
    ),
  ),
);
