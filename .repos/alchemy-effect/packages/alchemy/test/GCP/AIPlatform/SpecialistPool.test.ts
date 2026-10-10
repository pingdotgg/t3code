import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Vertex AI data labeling is shut down: create fails with BadRequest
// "Data labeling service is shutdown". Set GCP_TEST_AIPLATFORM_DATA_LABELING=1
// on a project that still has access.
const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_AIPLATFORM_DATA_LABELING;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsSpecialistPools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSpecialistPools on a missing pool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsSpecialistPools({
          name: `projects/${project}/locations/us-central1/specialistPools/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsSpecialistPools is rejected because data labeling is shut down",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const error = yield* Effect.flip(
        aiplatform.createProjectsLocationsSpecialistPools({
          parent: `projects/${project}/locations/us-central1`,
          body: {
            displayName: "alchemy-pool-probe",
            specialistManagerEmails: ["alchemy@example.com"],
          },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(String(error.message)).toContain("shutdown");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a specialist pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.SpecialistPool("Labelers", {
            location: "us-central1",
            displayName: "labelers",
          });
        }),
      );

      expect(created.name).toContain("/specialistPools/");
      expect(created.displayName).toEqual("labelers");

      const fetched = yield* aiplatform.getProjectsLocationsSpecialistPools({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.SpecialistPool("Labelers", {
            location: "us-central1",
            displayName: "labelers-v2",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("labelers-v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
