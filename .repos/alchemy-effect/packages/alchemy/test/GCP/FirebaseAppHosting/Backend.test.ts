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

const waitUntilGone = (name: string) =>
  firebaseapphosting.getProjectsLocationsBackends({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBackends on a missing backend fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const missingBackend = missingBackendOf(project);

      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseapphosting.getProjectsLocationsBackends({
          name: missingBackend(),
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* firebaseapphosting.listProjectsLocationsBackends({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.backends ?? []).map((item) => item.name)).not.toContain(
        missingBackend(),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseapphosting", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a backend",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const serviceAccount = serviceAccountOf(project);

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppHosting.Backend("Web", {
            serviceAccount,
            servingLocality: "GLOBAL_ACCESS",
            displayName: "alchemy-test-backend",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/backends/");
      expect(created.backendId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("alchemy-test-backend");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.servingLocality).toEqual("GLOBAL_ACCESS");

      const fetched = yield* firebaseapphosting.getProjectsLocationsBackends({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("alchemy-test-backend");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppHosting.Backend("Web", {
            backendId: created.backendId,
            serviceAccount,
            servingLocality: "GLOBAL_ACCESS",
            displayName: "alchemy-prod-backend",
            labels: { env: "prod", role: "web" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-backend");
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseapphosting", "live"],
    timeout: 300_000,
  },
);
