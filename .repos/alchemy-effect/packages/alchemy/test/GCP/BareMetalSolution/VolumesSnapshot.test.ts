import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as baremetalsolution from "@distilled.cloud/gcp/baremetalsolution_v2";
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

// Bare Metal Solution is contracted physical hardware (real cost) and the API
// is off on the testing project (ServiceDisabled: "Bare Metal Solution API has not
// been used in project ... or it is disabled."). Set
// GCP_TEST_BAREMETALSOLUTION_VOLUME to a provisioned boot volume on an
// entitled project to run the lifecycle.
const bootVolume = process.env.GCP_TEST_BAREMETALSOLUTION_VOLUME;
const runLifecycle = !!bootVolume;

const missingVolume = (projectId: string) =>
  `projects/${projectId}/locations/us-central1/volumes/alchemy-missing-boot`;

const waitUntilGone = (name: string) =>
  baremetalsolution.getProjectsLocationsVolumesSnapshots({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsVolumesSnapshots on a missing snapshot fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        baremetalsolution.getProjectsLocationsVolumesSnapshots({
          name: `${missingVolume(project)}/snapshots/alchemy-bms-snap-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:baremetalsolution", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "create is rejected with ServiceDisabled when the Bare Metal Solution API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.BareMetalSolution.VolumesSnapshot("Nightly", {
              volume: missingVolume(project),
              description: "alchemy-test-snap",
            });
          }),
        ),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:baremetalsolution", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a boot volume snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BareMetalSolution.VolumesSnapshot("Nightly", {
            volume: bootVolume!,
            description: "alchemy-test-snap",
          });
        }),
      );

      expect(created.name).toContain("/snapshots/");
      expect(created.snapshotId).toEqual(expect.any(String));
      expect(created.description).toEqual("alchemy-test-snap");

      const fetched =
        yield* baremetalsolution.getProjectsLocationsVolumesSnapshots({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-snap");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:baremetalsolution", "live"],
    timeout: 120_000,
  },
);
