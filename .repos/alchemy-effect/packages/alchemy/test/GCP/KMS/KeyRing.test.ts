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

// Cloud KMS KeyRings cannot be deleted. Reuse a constant id so re-runs
// observe the existing ring instead of leaking a new one every pass.

const waitUntilGone = (name: string) =>
  kms.getProjectsLocationsKeyRings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsKeyRings on a missing key ring fails with NotFound",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        kms.getProjectsLocationsKeyRings({
          name: `projects/${project}/locations/us-central1/keyRings/alchemy-keyring-does-not-exist`,
        }),
      );
      expect(error._tag).toBe("NotFound");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:kms", "live"] },
);

test.provider(
  "create, replace, and destroy a key ring",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
        }),
      );

      expect(created.keyRingId).toEqual(KEY_RING_ID);
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/keyRings/${KEY_RING_ID}`,
      );
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* kms.getProjectsLocationsKeyRings({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-central1",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.createTime).toEqual(created.createTime);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.KMS.KeyRing("Keys", {
            keyRingId: KEY_RING_ID,
            location: "us-east1",
          });
        }),
      );
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.keyRingId).toEqual(KEY_RING_ID);
      expect(replaced.name).toEqual(
        `projects/${project}/locations/us-east1/keyRings/${KEY_RING_ID}`,
      );

      const fetchedReplacement = yield* kms.getProjectsLocationsKeyRings({
        name: replaced.name,
      });
      expect(fetchedReplacement.name).toEqual(replaced.name);

      // The previous location's ring cannot be deleted and remains.
      const previous = yield* kms.getProjectsLocationsKeyRings({
        name: created.name,
      });
      expect(previous.name).toEqual(created.name);

      yield* stack.destroy();

      const stillThere = yield* kms
        .getProjectsLocationsKeyRings({ name: replaced.name })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(stillThere).toEqual("found");

      const gone = yield* waitUntilGone(
        `projects/${project}/locations/us-central1/keyRings/alchemy-keyring-does-not-exist`,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:kms", "live"], timeout: 90_000 },
);
