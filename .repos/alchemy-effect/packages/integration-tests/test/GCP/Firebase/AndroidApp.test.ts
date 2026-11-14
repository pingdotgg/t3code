import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as firebase from "@distilled.cloud/gcp/firebase_v1beta1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Android apps need a Firebase project; adding Firebase to a GCP project is
// permanent, and the testing project has none (createAndroidApps: NotFound
// "Firebase project N not found."). Set GCP_TEST_FIREBASE_PROJECT=1 on a
// Firebase project.
const runLifecycle = !!process.env.GCP_TEST_FIREBASE_PROJECT;

const waitUntilGone = (name: string) =>
  firebase.getProjectsAndroidApps({ name }).pipe(
    Effect.map((app) => (app.state === "DELETED" ? ("gone" as const) : ("found" as const))),
    Effect.catchTag(["NotFound", "AndroidAppNotFound"], () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 8,
    }),
  );

// App ids are globally unique, so the `projects/-` wildcard resolves the app
// without the project: Firebase answers a missing id there with the typed 403.
// Under `projects/{project}` a project without Firebase (the testing project)
// answers every app lookup with a generic 400 INVALID_ARGUMENT instead.
test.provider(
  "getProjectsAndroidApps on a missing app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebase.getProjectsAndroidApps({
          name: "projects/-/androidApps/1:1:android:missing",
        }),
      );
      expect(error._tag).toEqual("AndroidAppNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firebase", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsAndroidApps without Firebase fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebase.createProjectsAndroidApps({
          parent: `projects/${project}`,
          body: {
            packageName: "com.alchemy.test.probe",
            displayName: "alchemy-probe",
          },
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firebase", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an android app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebase.AndroidApp("Mobile", {
            displayName: "mobile",
          });
        }),
      );

      expect(created.name).toContain("/androidApps/");
      expect(created.appId).toEqual(expect.any(String));
      expect(created.packageName).toContain("com.alchemy.test.");
      expect(created.displayName).toEqual("mobile");

      const fetched = yield* firebase.getProjectsAndroidApps({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebase.AndroidApp("Mobile", {
            packageName: created.packageName,
            displayName: "mobile-v2",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("mobile-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firebase", "live"], timeout: 90_000 },
);
