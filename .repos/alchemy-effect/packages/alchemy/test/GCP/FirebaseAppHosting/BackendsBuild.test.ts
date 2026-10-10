import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaseapphosting from "@distilled.cloud/gcp/firebaseapphosting_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  location,
  logLevel,
  missingBackendOf,
  currentProject,
  serviceAccountOf,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const helloImage = "us-docker.pkg.dev/cloudrun/container/hello";

const waitUntilGone = (name: string) =>
  firebaseapphosting.getProjectsLocationsBackendsBuilds({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBackendsBuilds on a missing build fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingBackend = missingBackendOf(project);

      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseapphosting.getProjectsLocationsBackendsBuilds({
          name: `${missingBackend()}/builds/alchemy-missing-build`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page =
        yield* firebaseapphosting.listProjectsLocationsBackendsBuilds({
          parent: `projects/${project}/locations/-/backends/-`,
          pageSize: 10,
        });
      expect((page.builds ?? []).map((item) => item.name)).not.toContain(
        `${missingBackend()}/builds/alchemy-missing-build`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseapphosting", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create against a missing backend is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingBackend = missingBackendOf(project);

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.FirebaseAppHosting.BackendsBuild("Hello", {
              backend: missingBackend(),
              source: { container: { image: helloImage } },
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseapphosting", "live"],
    timeout: 90_000,
  },
);

// A build reaches READY in about a minute, but its delete LRO was still
// `done: false` after 14 minutes, so the test cannot clean up. Set
// GCP_TEST_FIREBASE_APP_HOSTING_BUILD=1 to run it anyway.
test.provider.skipIf(!process.env.GCP_TEST_FIREBASE_APP_HOSTING_BUILD)(
  "create, verify, and delete a backend build",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const serviceAccount = serviceAccountOf(project);

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const backend = yield* GCP.FirebaseAppHosting.Backend("Web", {
            serviceAccount,
            servingLocality: "GLOBAL_ACCESS",
            displayName: "alchemy-test-build-backend",
            labels: { env: "test" },
          });
          const build = yield* GCP.FirebaseAppHosting.BackendsBuild("Hello", {
            backend: backend.name,
            source: { container: { image: helloImage } },
            displayName: "alchemy-test-build",
            labels: { env: "test" },
          });
          return { backend, build };
        }),
      );

      expect(created.build.name).toContain("/builds/");
      expect(created.build.backend).toEqual(created.backend.name);
      expect(created.build.location).toEqual(location);
      expect(created.build.source?.container?.image).toEqual(helloImage);
      expect(created.build.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* firebaseapphosting.getProjectsLocationsBackendsBuilds({
          name: created.build.name,
        });
      expect(fetched.name).toEqual(created.build.name);
      expect(fetched.source?.container?.image).toEqual(helloImage);
      expect(fetched.labels?.env).toEqual("test");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.build.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseapphosting", "live"],
    timeout: 900_000,
  },
);
