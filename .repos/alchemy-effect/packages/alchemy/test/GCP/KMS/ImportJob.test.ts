import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { KEY_RING_ID } from "./common.ts";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
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

// Cloud KMS KeyRings and ImportJobs cannot be deleted. Reuse constant
// ids so re-runs observe the existing resources instead of leaking.
const IMPORT_JOB_ID = "alchemy-test-importjob";

const waitUntilGone = (name: string) =>
  kms.getProjectsLocationsKeyRingsImportJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsKeyRingsImportJobs on a missing job fails with NotFound",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        kms.getProjectsLocationsKeyRingsImportJobs({
          name: `projects/${project}/locations/us-central1/keyRings/${KEY_RING_ID}/importJobs/alchemy-importjob-does-not-exist`,
        }),
      );
      expect(error._tag).toBe("NotFound");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:kms", "live"] },
);

test.provider(
  "create and destroy an import job",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          return yield* GCP.KMS.ImportJob("Wrap", {
            keyRing: ring.name,
            importJobId: IMPORT_JOB_ID,
            importMethod: "RSA_OAEP_3072_SHA256_AES_256",
            protectionLevel: "SOFTWARE",
          });
        }),
      );

      expect(created.importJobId).toEqual(IMPORT_JOB_ID);
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.keyRing).toContain(`/keyRings/${KEY_RING_ID}`);
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/keyRings/${KEY_RING_ID}/importJobs/${IMPORT_JOB_ID}`,
      );
      expect(created.importMethod).toEqual("RSA_OAEP_3072_SHA256_AES_256");
      expect(created.protectionLevel).toEqual("SOFTWARE");
      expect(created.createTime).toEqual(expect.any(String));
      expect(["ACTIVE", "EXPIRED"]).toContain(created.state);
      if (created.state === "ACTIVE") {
        expect(created.publicKeyPem ?? created.publicKeyData).toEqual(
          expect.any(String),
        );
      }

      const fetched = yield* kms.getProjectsLocationsKeyRingsImportJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.importMethod).toEqual("RSA_OAEP_3072_SHA256_AES_256");
      expect(fetched.protectionLevel).toEqual("SOFTWARE");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ring = yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
          return yield* GCP.KMS.ImportJob("Wrap", {
            keyRing: ring.name,
            importJobId: IMPORT_JOB_ID,
            importMethod: "RSA_OAEP_3072_SHA256_AES_256",
            protectionLevel: "SOFTWARE",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.createTime).toEqual(created.createTime);

      yield* stack.destroy();

      const stillThere = yield* kms
        .getProjectsLocationsKeyRingsImportJobs({ name: created.name })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(stillThere).toEqual("found");

      const gone = yield* waitUntilGone(
        `projects/${project}/locations/us-central1/keyRings/${KEY_RING_ID}/importJobs/alchemy-importjob-does-not-exist`,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:kms", "live"], timeout: 90_000 },
);
