import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as firebaseappdistribution from "@distilled.cloud/gcp/firebaseappdistribution_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const currentParent = GcpEnvironment.current.pipe(
  Effect.map(({ project }) => `projects/${project}`),
);
// The Firebase App Distribution API is not enabled in the testing project.
// Set GCP_TEST_FIREBASE_APP_DISTRIBUTION=1 on a project where it is.
const entitled = !!process.env.GCP_TEST_FIREBASE_APP_DISTRIBUTION;

const waitUntilGone = (name: string) =>
  firebaseappdistribution.getProjectsGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!entitled)(
  "getProjectsGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseappdistribution.getProjectsGroups({
          name: `${parent}/groups/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseappdistribution", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(entitled)(
  "getProjectsGroups fails with ServiceDisabled while the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseappdistribution.getProjectsGroups({
          name: `${parent}/groups/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseappdistribution", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!entitled)(
  "create, update, and delete a tester group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppDistribution.Group("Qa", {
            displayName: "qa",
          });
        }),
      );

      expect(created.name).toContain("/groups/");
      expect(created.groupId).toEqual(expect.any(String));
      expect(created.groupId.length).toBeGreaterThanOrEqual(4);
      expect(created.project).toEqual(expect.any(String));
      expect(created.displayName).toEqual("qa");

      const fetched = yield* firebaseappdistribution.getProjectsGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      // The display name is shown to testers: no ownership marker.
      expect(fetched.displayName).toEqual("qa");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppDistribution.Group("Qa", {
            groupId: created.groupId,
            displayName: "qa-prod",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.groupId).toEqual(created.groupId);
      expect(updated.displayName).toEqual("qa-prod");

      const refetched = yield* firebaseappdistribution.getProjectsGroups({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("qa-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseappdistribution", "live"],
    timeout: 90_000,
  },
);
