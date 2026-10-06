import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsRepositoriesWorkflowConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataform.getProjectsLocationsRepositoriesWorkflowConfigs({
          name: `projects/${project}/locations/us-central1/repositories/missing/workflowConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a dataform workflow config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const serviceAccount =
            "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com";
          const repo = yield* GCP.Dataform.Repository("WorkflowRepo", {
            location: "us-central1",
            displayName: "workflow-repo",
            labels: { env: "test" },
            serviceAccount,
          });
          const release = yield* GCP.Dataform.RepositoriesReleaseConfig(
            "Release",
            {
              repository: repo.name,
              gitCommitish: "main",
              disabled: true,
            },
          );
          const workflow = yield* GCP.Dataform.RepositoriesWorkflowConfig(
            "Hourly",
            {
              repository: repo.name,
              releaseConfig: release.name,
              disabled: true,
              invocationConfig: { serviceAccount },
            },
          );
          return { repo, release, workflow };
        }),
      );

      expect(created.workflow.name).toContain("/workflowConfigs/");
      expect(created.workflow.releaseConfig).toEqual(created.release.name);
      expect(created.workflow.disabled).toEqual(true);

      const fetched =
        yield* dataform.getProjectsLocationsRepositoriesWorkflowConfigs({
          name: created.workflow.name,
        });
      expect(fetched.name).toEqual(created.workflow.name);
      expect(fetched.releaseConfig).toEqual(created.release.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const serviceAccount =
            "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com";
          const repo = yield* GCP.Dataform.Repository("WorkflowRepo", {
            repositoryId: created.repo.repositoryId,
            location: "us-central1",
            displayName: "workflow-repo",
            labels: { env: "test" },
            serviceAccount,
          });
          const release = yield* GCP.Dataform.RepositoriesReleaseConfig(
            "Release",
            {
              repository: repo.name,
              releaseConfigId: created.release.releaseConfigId,
              gitCommitish: "main",
              disabled: true,
            },
          );
          const workflow = yield* GCP.Dataform.RepositoriesWorkflowConfig(
            "Hourly",
            {
              repository: repo.name,
              workflowConfigId: created.workflow.workflowConfigId,
              releaseConfig: release.name,
              disabled: true,
              timeZone: "UTC",
              invocationConfig: { serviceAccount },
            },
          );
          return { repo, release, workflow };
        }),
      );

      expect(updated.workflow.name).toEqual(created.workflow.name);
      expect(updated.workflow.timeZone).toEqual("UTC");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        dataform.getProjectsLocationsRepositoriesWorkflowConfigs({
          name: created.workflow.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 120_000 },
);
