import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsRepositories on a missing repository fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataform.getProjectsLocationsRepositories({
          name: `projects/${project}/locations/us-central1/repositories/alchemy-missing-repo`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a dataform repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataform.Repository("Analytics", {
            location: "us-central1",
            displayName: "analytics-repo",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/repositories/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("analytics-repo");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataform.getProjectsLocationsRepositories({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("analytics-repo");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataform.Repository("Analytics", {
            repositoryId: created.repositoryId,
            location: "us-central1",
            displayName: "analytics-repo-v2",
            labels: { env: "prod", role: "dataform" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("analytics-repo-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "dataform" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        dataform.getProjectsLocationsRepositories({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 90_000 },
);
