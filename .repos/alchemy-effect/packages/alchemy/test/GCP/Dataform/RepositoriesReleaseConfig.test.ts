import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsRepositoriesReleaseConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataform.getProjectsLocationsRepositoriesReleaseConfigs({
          name: `projects/${project}/locations/us-central1/repositories/missing/releaseConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a dataform release config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* GCP.Dataform.Repository("ReleaseRepo", {
            location: "us-central1",
            displayName: "release-repo",
            labels: { env: "test" },
            serviceAccount:
              "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com",
          });
          const release = yield* GCP.Dataform.RepositoriesReleaseConfig(
            "Prod",
            {
              repository: repo.name,
              gitCommitish: "main",
              disabled: true,
            },
          );
          return { repo, release };
        }),
      );

      expect(created.release.name).toContain("/releaseConfigs/");
      expect(created.release.gitCommitish).toEqual("main");
      expect(created.release.disabled).toEqual(true);
      expect(created.release.vars).toMatchObject({});

      const fetched =
        yield* dataform.getProjectsLocationsRepositoriesReleaseConfigs({
          name: created.release.name,
        });
      expect(fetched.name).toEqual(created.release.name);
      expect(fetched.gitCommitish).toEqual("main");
      expect(fetched.codeCompilationConfig?.vars?.["alchemy-id"]).toEqual(
        expect.any(String),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* GCP.Dataform.Repository("ReleaseRepo", {
            repositoryId: created.repo.repositoryId,
            location: "us-central1",
            displayName: "release-repo",
            labels: { env: "test" },
            serviceAccount:
              "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com",
          });
          const release = yield* GCP.Dataform.RepositoriesReleaseConfig(
            "Prod",
            {
              repository: repo.name,
              releaseConfigId: created.release.releaseConfigId,
              gitCommitish: "main",
              disabled: true,
              timeZone: "UTC",
            },
          );
          return { repo, release };
        }),
      );

      expect(updated.release.name).toEqual(created.release.name);
      expect(updated.release.timeZone).toEqual("UTC");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        dataform.getProjectsLocationsRepositoriesReleaseConfigs({
          name: created.release.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 120_000 },
);
