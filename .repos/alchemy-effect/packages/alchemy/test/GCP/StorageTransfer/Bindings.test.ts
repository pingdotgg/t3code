import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import StorageTransferBindingsHost, {
  Copy,
  SEED_KEY,
  SEED_TEXT,
  Sink,
  Source,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "StorageTransferBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let jobName: string;
let sinkBucket: string;
let transferAccount: string;

/** Project-level roles held by the host's service account. */
const projectRoles = () =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
          )
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          }))
          .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? "")),
      ),
    );

/**
 * Let the Google-managed transfer agent read the source and write the
 * sink (the transfer itself runs as that agent, not as the host).
 */
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
      body: { ...policy, bindings },
    });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 4,
      schedule: Schedule.spaced("500 millis"),
    }),
  );

describe.skipIf(!dockerAvailable)(
  "StorageTransfer Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:storagetransfer",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        // The job's buckets must admit the transfer agent before the job
        // exists, so deploy them first.
        const buckets = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const source = yield* Source;
            const sink = yield* Sink;
            const { project } = yield* GcpEnvironment.current;
            return {
              project,
              source: source.bucketName,
              sink: sink.bucketName,
            };
          }),
        );
        // Out-of-band calls in a hook need the provider services.
        yield* Core.withProviders(
          Effect.gen(function* () {
            const account = yield* storagetransfer.getGoogleServiceAccounts({
              projectId: buckets.project,
            });
            const member = `serviceAccount:${account.accountEmail}`;
            yield* grantBucketRole(
              buckets.source,
              member,
              "roles/storage.objectViewer",
            );
            yield* grantBucketRole(
              buckets.source,
              member,
              "roles/storage.legacyBucketReader",
            );
            yield* grantBucketRole(
              buckets.sink,
              member,
              "roles/storage.legacyBucketWriter",
            );
            yield* grantBucketRole(
              buckets.sink,
              member,
              "roles/storage.objectAdmin",
            );
          }),
          testOptions,
          "StorageTransferBindings",
        );
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* StorageTransferBindingsHost;
            const job = yield* Copy;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              job: job.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        jobName = out.job;
        sinkBucket = buckets.sink;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetGoogleServiceAccount", () => {
      test.provider(
        "returns the project's transfer agent as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ accountEmail: string }>(
              baseUrl,
              "getGoogleServiceAccount",
            );
            const account = yield* storagetransfer.getGoogleServiceAccounts({
              projectId: project,
            });
            expect(out.accountEmail).toEqual(account.accountEmail);
            expect(out.accountEmail).toMatch(
              /^project-\d+@storage-transfer-service\.iam\.gserviceaccount\.com$/,
            );
            expect(yield* projectRoles()).toContainEqual({
              role: "roles/storagetransfer.viewer",
              condition: undefined,
            });
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storagetransfer", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("RunTransferJob", () => {
      test.provider(
        "runs the bound job as the host and the object lands in the sink",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* expectProbe<{ name: string }>(
              baseUrl,
              "runTransferJob",
            );
            expect(started.name).toMatch(/^transferOperations\//);

            const operation = yield* storagetransfer
              .getTransferOperations({ name: started.name })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (current) => current.done === true,
                  times: 30,
                }),
              );
            expect(operation.done).toEqual(true);
            expect(operation.error).toEqual(undefined);
            expect(operation.metadata?.transferJobName).toEqual(jobName);

            const copied = yield* storage.getObjects({
              bucket: sinkBucket,
              object: SEED_KEY,
            });
            expect(copied.size).toEqual(String(SEED_TEXT.length));

            expect(yield* projectRoles()).toEqual([
              { role: "roles/storagetransfer.user", condition: undefined },
              { role: "roles/storagetransfer.viewer", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storagetransfer", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
