import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const runLifecycle = !process.env.FAST;

test.provider(
  "getProjectsLocationsRepositoriesWorkflowInvocations on a missing invocation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataform.getProjectsLocationsRepositoriesWorkflowInvocations({
          name: `projects/${project}/locations/us-central1/repositories/missing/workflowInvocations/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 90_000 },
);

const writeWorkspaceFile = (workspace: string, path: string, text: string) =>
  Effect.gen(function* () {
    const contents = yield* Effect.sync(() =>
      Buffer.from(text, "utf8").toString("base64"),
    );
    return yield* dataform.writeFileProjectsLocationsRepositoriesWorkspaces({
      workspace,
      body: { path, contents },
    });
  });

test.provider.skipIf(!runLifecycle)(
  "create and delete a dataform workflow invocation",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* GCP.Dataform.Repository("InvocationRepo", {
            location: "us-central1",
            displayName: "invocation-repo",
            labels: { env: "test" },
            serviceAccount:
              "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com",
          });
          const workspace = yield* GCP.Dataform.RepositoriesWorkspace("Dev", {
            repository: repo.name,
          });
          return { repo, workspace };
        }),
      );

      yield* writeWorkspaceFile(
        created.workspace.name,
        "package.json",
        JSON.stringify({
          name: "dataform",
          dependencies: { "@dataform/core": "3.0.0" },
        }),
      );
      yield* writeWorkspaceFile(
        created.workspace.name,
        "workflow_settings.yaml",
        [
          `defaultProject: ${project}`,
          "defaultLocation: US",
          "defaultDataset: dataform",
          "defaultAssertionDataset: dataform_assertions",
        ].join("\n"),
      );
      yield* dataform
        .makeDirectoryProjectsLocationsRepositoriesWorkspaces({
          workspace: created.workspace.name,
          body: { path: "definitions" },
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));
      yield* writeWorkspaceFile(
        created.workspace.name,
        "definitions/example.sqlx",
        'config { type: "view" }\nSELECT 1 AS x\n',
      );

      const compilation =
        yield* dataform.createProjectsLocationsRepositoriesCompilationResults({
          parent: created.repo.name,
          body: { workspace: created.workspace.name },
        });
      expect(compilation.name).toEqual(expect.any(String));

      const invoked = yield* stack.deploy(
        Effect.gen(function* () {
          const repo = yield* GCP.Dataform.Repository("InvocationRepo", {
            repositoryId: created.repo.repositoryId,
            location: "us-central1",
            displayName: "invocation-repo",
            labels: { env: "test" },
            serviceAccount:
              "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com",
          });
          const workspace = yield* GCP.Dataform.RepositoriesWorkspace("Dev", {
            repository: repo.name,
            workspaceId: created.workspace.workspaceId,
          });
          const invocation = yield* GCP.Dataform.RepositoriesWorkflowInvocation(
            "Run",
            {
              repository: repo.name,
              compilationResult: compilation.name,
            },
          );
          return { repo, workspace, invocation };
        }),
      );

      expect(invoked.invocation.name).toContain("/workflowInvocations/");
      expect(invoked.invocation.compilationResult).toContain(
        "/compilationResults/",
      );
      expect(invoked.invocation.compilationResult).toContain(
        compilation.name?.split("/").pop() ?? "compilationResults",
      );

      const fetched =
        yield* dataform.getProjectsLocationsRepositoriesWorkflowInvocations({
          name: invoked.invocation.name,
        });
      expect(fetched.name).toEqual(invoked.invocation.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        dataform.getProjectsLocationsRepositoriesWorkflowInvocations({
          name: invoked.invocation.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 180_000 },
);
