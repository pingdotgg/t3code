import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
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

const denyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const authRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const waitUntilGone = (name: string) =>
  firebaserules.getProjectsReleases({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsReleases on a missing release fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaserules.getProjectsReleases({
          name: `projects/${project}/releases/alchemy-missing-xxxx`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaserules", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, replace, and delete a firebaserules release",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleset = yield* GCP.FirebaseRules.Ruleset("Firestore", {
            source: {
              files: [{ name: "firestore.rules", content: denyRules }],
            },
          });
          const release = yield* GCP.FirebaseRules.Release("Live", {
            rulesetName: ruleset.name,
          });
          return { ruleset, release };
        }),
      );

      expect(created.release.releaseId.startsWith("alc-")).toEqual(true);
      expect(created.release.name).toEqual(
        `projects/${project}/releases/${created.release.releaseId}`,
      );
      expect(created.release.rulesetName).toEqual(created.ruleset.name);
      expect(created.release.project).toEqual(project);

      const fetched = yield* firebaserules.getProjectsReleases({
        name: created.release.name,
      });
      expect(fetched.name).toEqual(created.release.name);
      expect(fetched.rulesetName).toEqual(created.ruleset.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleset = yield* GCP.FirebaseRules.Ruleset("Firestore", {
            source: {
              files: [{ name: "firestore.rules", content: denyRules }],
            },
          });
          const next = yield* GCP.FirebaseRules.Ruleset("FirestoreNext", {
            source: {
              files: [{ name: "firestore.rules", content: authRules }],
            },
          });
          const release = yield* GCP.FirebaseRules.Release("Live", {
            releaseId: created.release.releaseId,
            rulesetName: next.name,
          });
          return { ruleset, next, release };
        }),
      );

      expect(updated.release.name).toEqual(created.release.name);
      expect(updated.release.rulesetName).toEqual(updated.next.name);
      expect(updated.release.rulesetName).not.toEqual(created.ruleset.name);

      const fetchedUpdate = yield* firebaserules.getProjectsReleases({
        name: created.release.name,
      });
      expect(fetchedUpdate.rulesetName).toEqual(updated.next.name);

      const nextReleaseId = `${created.release.releaseId}-v2`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const next = yield* GCP.FirebaseRules.Ruleset("FirestoreNext", {
            source: {
              files: [{ name: "firestore.rules", content: authRules }],
            },
          });
          const release = yield* GCP.FirebaseRules.Release("Live", {
            releaseId: nextReleaseId,
            rulesetName: next.name,
          });
          return { next, release };
        }),
      );

      expect(replaced.release.releaseId).toEqual(nextReleaseId);
      expect(replaced.release.name).not.toEqual(created.release.name);

      const previousGone = yield* waitUntilGone(created.release.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.release.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaserules", "live"],
    timeout: 90_000,
  },
);
