import * as AWS from "@/AWS";
import * as Output from "@/Output";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Bindings fixture: an S3 bucket + access point plus a Lambda that exercises
// the nine ungated S3 Control runtime bindings against them — the three
// access-point-scoped reads, the account-level access point listing, and the
// full S3 Batch Operations job loop (create suspended → describe → bump
// priority → cancel → list).
export class S3ControlBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "S3ControlBindingsFunction",
) {}

export class BoundAccessPoint extends Context.Service<
  BoundAccessPoint,
  {
    accessPoint: AWS.S3Control.AccessPoint;
    bucket: AWS.S3.Bucket;
    batchRole: AWS.IAM.Role;
  }
>()("BoundAccessPoint") {}

export const BoundAccessPointLive = Layer.effect(
  BoundAccessPoint,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("S3ControlBindingsBucket", {});
    const accessPoint = yield* AWS.S3Control.AccessPoint(
      "S3ControlBindingsAccessPoint",
      { bucket: bucket.bucketName },
    );
    // Execution role handed to S3 Batch Operations via CreateJob. The job is
    // cancelled while suspended, so the role's policy only needs to satisfy
    // create-time validation.
    const batchRole = yield* AWS.IAM.Role("S3ControlBindingsBatchRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "batchoperations.s3.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        BatchAccess: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:ListBucket", "s3:GetObject", "s3:PutObjectTagging"],
              Resource: [
                bucket.bucketArn,
                Output.interpolate`${bucket.bucketArn}/*`,
              ],
            },
          ],
        },
      },
    });
    return { accessPoint, bucket, batchRole };
  }),
);

export default S3ControlBindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const { accessPoint, bucket, batchRole } = yield* BoundAccessPoint;

    const getAccessPoint = yield* AWS.S3Control.GetAccessPoint(accessPoint);
    const getAccessPointPolicy =
      yield* AWS.S3Control.GetAccessPointPolicy(accessPoint);
    const getAccessPointPolicyStatus =
      yield* AWS.S3Control.GetAccessPointPolicyStatus(accessPoint);
    const listAccessPoints = yield* AWS.S3Control.ListAccessPoints();
    const createJob = yield* AWS.S3Control.CreateJob();
    const describeJob = yield* AWS.S3Control.DescribeJob();
    const listJobs = yield* AWS.S3Control.ListJobs();
    const updateJobStatus = yield* AWS.S3Control.UpdateJobStatus();
    const updateJobPriority = yield* AWS.S3Control.UpdateJobPriority();

    const bound = {
      getAccessPoint,
      getAccessPointPolicy,
      getAccessPointPolicyStatus,
      listAccessPoints,
      createJob,
      describeJob,
      listJobs,
      updateJobStatus,
      updateJobPriority,
    };

    const bucketName = yield* bucket.bucketName;
    const bucketArn = yield* bucket.bucketArn;
    const batchRoleArn = yield* batchRole.roleArn;

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

        if (request.method === "GET" && pathname === "/access-point") {
          const live = yield* getAccessPoint();
          return yield* HttpServerResponse.json({
            name: live.Name,
            bucket: live.Bucket,
            networkOrigin: live.NetworkOrigin,
          });
        }

        if (request.method === "GET" && pathname === "/policy") {
          const result = yield* getAccessPointPolicy().pipe(
            Effect.map((r) => ({ hasPolicy: r.Policy !== undefined })),
            // A fresh access point has no policy — the typed tag proves the
            // binding round-trips.
            Effect.catchTag("NoSuchAccessPointPolicy", () =>
              Effect.succeed({ hasPolicy: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/policy-status") {
          const result = yield* getAccessPointPolicyStatus().pipe(
            Effect.map((r) => ({
              isPublic: r.PolicyStatus?.IsPublic ?? false,
              hasPolicy: true,
            })),
            Effect.catchTag("NoSuchAccessPointPolicy", () =>
              Effect.succeed({ isPublic: false, hasPolicy: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/access-points") {
          const page = yield* listAccessPoints({
            Bucket: yield* bucketName,
          });
          return yield* HttpServerResponse.json({
            names: (page.AccessPointList ?? []).map((ap) => ap.Name),
          });
        }

        if (request.method === "GET" && pathname === "/job-lifecycle") {
          // Wrapped in Effect.result so a failing step surfaces its typed
          // tag in the JSON body instead of an opaque 500.
          const outcome = yield* Effect.result(
            Effect.gen(function* () {
              // 1. CREATE — a suspended (ConfirmationRequired) tagging job over a
              //    generated manifest; nothing executes because it is cancelled
              //    below. Cancelled jobs are inert metadata that S3 expires
              //    automatically after 90 days.
              const token = yield* Effect.sync(() => crypto.randomUUID());
              const created = yield* createJob({
                ClientRequestToken: token,
                ConfirmationRequired: true,
                Priority: 1,
                RoleArn: yield* batchRoleArn,
                Operation: {
                  S3PutObjectTagging: {
                    TagSet: [{ Key: "alchemy-sweep", Value: "true" }],
                  },
                },
                Report: { Enabled: false },
                ManifestGenerator: {
                  S3JobManifestGenerator: {
                    SourceBucket: yield* bucketArn,
                    EnableManifestOutput: false,
                  },
                },
              });
              const jobId = created.JobId!;

              // 2. DESCRIBE — poll (bounded) until the job settles out of
              //    New/Preparing into a stable state.
              const settledStates = [
                "Suspended",
                "Failed",
                "Complete",
                "Cancelled",
                "Ready",
                "Active",
              ];
              const settled = yield* describeJob({ JobId: jobId }).pipe(
                Effect.map((r) => ({ status: r.Job?.Status as string })),
                Effect.repeat({
                  schedule: Schedule.spaced("2 seconds"),
                  until: (r): boolean => settledStates.includes(r.status),
                  times: 25,
                }),
              );

              // 3. PRIORITY — a settled ConfirmationRequired job refuses
              //    priority changes with the typed
              //    JobStatusTransitionForbidden tag; either outcome proves
              //    the binding (and the distilled patch) end-to-end.
              const priorityOutcome = yield* updateJobPriority({
                JobId: jobId,
                Priority: 5,
              }).pipe(
                Effect.map(() => "updated" as const),
                Effect.catchTag("JobStatusTransitionForbidden", () =>
                  Effect.succeed("JobStatusTransitionForbidden" as const),
                ),
              );

              // 4. CANCEL — a suspended job cancels; a job that already
              //    settled terminally (Failed/Complete) refuses with the
              //    typed tag. Both prove the UpdateJobStatus binding.
              const cancelOutcome = yield* updateJobStatus({
                JobId: jobId,
                RequestedJobStatus: "Cancelled",
                StatusUpdateReason: "alchemy sweep test",
              }).pipe(
                Effect.map((r) => (r.Status ?? "Cancelled") as string),
                Effect.catchTag("JobStatusTransitionForbidden", () =>
                  Effect.succeed("JobStatusTransitionForbidden" as const),
                ),
              );

              // Observe the job's final state after the cancel attempt.
              const final = yield* describeJob({ JobId: jobId });
              const finalStatus = final.Job?.Status ?? "Cancelled";

              // 5. LIST — the job is observable in the account listing.
              // NOTE: a single status value only — distilled's SigV4 signer
              // currently mis-signs repeated query params
              // (jobStatuses=A&jobStatuses=B → SignatureDoesNotMatch).
              const listed = yield* listJobs({
                JobStatuses: [finalStatus],
              });

              return {
                ok: true as const,
                jobId,
                settledStatus: settled.status,
                priorityOutcome,
                cancelOutcome,
                finalStatus: finalStatus as string,
                listedJobIds: (listed.Jobs ?? []).map((j) => j.JobId),
              };
            }),
          );

          if (Result.isFailure(outcome)) {
            return yield* HttpServerResponse.json({
              ok: false as const,
              tag: outcome.failure._tag,
              message: `${String(outcome.failure)} ${JSON.stringify(outcome.failure)}`,
            });
          }
          return yield* HttpServerResponse.json(outcome.success);
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
        AWS.S3Control.GetAccessPointHttp,
        AWS.S3Control.GetAccessPointPolicyHttp,
        AWS.S3Control.GetAccessPointPolicyStatusHttp,
        AWS.S3Control.ListAccessPointsHttp,
        AWS.S3Control.CreateJobHttp,
        AWS.S3Control.DescribeJobHttp,
        AWS.S3Control.ListJobsHttp,
        AWS.S3Control.UpdateJobStatusHttp,
        AWS.S3Control.UpdateJobPriorityHttp,
        BoundAccessPointLive,
      ),
    ),
  ),
);
