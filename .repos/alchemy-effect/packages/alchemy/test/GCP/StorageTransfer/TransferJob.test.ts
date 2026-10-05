import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (jobName: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;

    return yield* storagetransfer
      .getTransferJobs({ jobName, projectId: project })
      .pipe(
        Effect.map((job) =>
          job.status === "DELETED" ? ("gone" as const) : ("found" as const),
        ),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 10,
        }),
      );
  });

const grantBucketRole = (bucket: string, member: string, role: string) =>
  Effect.gen(function* () {
    const policy = yield* storage.getIamPolicyBuckets({
      bucket,
      optionsRequestedPolicyVersion: 3,
    });
    const bindings = [...(policy.bindings ?? [])];
    const existing = bindings.find((binding) => binding.role === role);
    if (existing?.members?.includes(member)) return;
    if (existing) {
      existing.members = [...(existing.members ?? []), member];
    } else {
      bindings.push({ role, members: [member] });
    }
    yield* storage.setIamPolicyBuckets({
      bucket,
      body: {
        ...policy,
        bindings,
      },
    });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 4,
      schedule: Schedule.spaced("500 millis"),
    }),
  );

const grantTransferAccess = (
  sourceBucket: string,
  sinkBucket: string,
  email: string,
) => {
  const member = `serviceAccount:${email}`;
  return Effect.all(
    [
      grantBucketRole(sourceBucket, member, "roles/storage.legacyBucketReader"),
      grantBucketRole(sourceBucket, member, "roles/storage.objectViewer"),
      grantBucketRole(sinkBucket, member, "roles/storage.legacyBucketReader"),
      grantBucketRole(sinkBucket, member, "roles/storage.objectAdmin"),
    ],
    { concurrency: 1 },
  );
};

test.provider(
  "create, update, and delete a transfer job",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const buckets = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Storage.Bucket("Src", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const sink = yield* GCP.Storage.Bucket("Dst", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return {
            sourceBucket: source.bucketName.as<string>(),
            sinkBucket: sink.bucketName.as<string>(),
          };
        }),
      );

      const account = yield* storagetransfer.getGoogleServiceAccounts({
        projectId: project,
      });
      if (account.accountEmail) {
        yield* grantTransferAccess(
          buckets.sourceBucket,
          buckets.sinkBucket,
          account.accountEmail,
        );
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GCP.Storage.Bucket("Src", {
            bucketName: buckets.sourceBucket,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          yield* GCP.Storage.Bucket("Dst", {
            bucketName: buckets.sinkBucket,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.StorageTransfer.TransferJob("Copy", {
            description: "copy uploads",
            status: "DISABLED",
            transferSpec: {
              gcsDataSource: { bucketName: buckets.sourceBucket },
              gcsDataSink: { bucketName: buckets.sinkBucket },
            },
          });
        }),
      );

      expect(created.jobId).toEqual(expect.any(String));
      expect(created.name).toEqual(`transferJobs/${created.jobId}`);
      expect(created.project).toEqual(project);
      expect(created.description).toEqual("copy uploads");
      expect(created.status).toEqual("DISABLED");
      expect(created.transferSpec?.gcsDataSource?.bucketName).toEqual(
        buckets.sourceBucket,
      );
      expect(created.transferSpec?.gcsDataSink?.bucketName).toEqual(
        buckets.sinkBucket,
      );

      const fetched = yield* storagetransfer.getTransferJobs({
        jobName: created.name,
        projectId: project,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.status).toEqual("DISABLED");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("copy uploads");
      expect(fetched.transferSpec?.gcsDataSource?.bucketName).toEqual(
        buckets.sourceBucket,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GCP.Storage.Bucket("Src", {
            bucketName: buckets.sourceBucket,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          yield* GCP.Storage.Bucket("Dst", {
            bucketName: buckets.sinkBucket,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.StorageTransfer.TransferJob("Copy", {
            jobId: created.jobId,
            description: "copy inbox",
            status: "DISABLED",
            transferSpec: {
              gcsDataSource: {
                bucketName: buckets.sourceBucket,
                path: "inbox/",
              },
              gcsDataSink: { bucketName: buckets.sinkBucket },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.jobId).toEqual(created.jobId);
      expect(updated.description).toEqual("copy inbox");
      expect(updated.transferSpec?.gcsDataSource?.path).toEqual("inbox/");

      const fetchedUpdate = yield* storagetransfer.getTransferJobs({
        jobName: created.name,
        projectId: project,
      });
      expect(fetchedUpdate.description).toContain("copy inbox");
      expect(fetchedUpdate.transferSpec?.gcsDataSource?.path).toEqual("inbox/");
      expect(fetchedUpdate.status).toEqual("DISABLED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:storagetransfer", "live"],
    timeout: 120_000,
  },
);
