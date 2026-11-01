import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import * as workflows from "@distilled.cloud/gcp/workflows_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<
    GCP.ProviderRequirements,
    never,
    StackServices
  >,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const SOURCE_V1 = `main:
  steps:
    - done:
        return: hello
`;

const SOURCE_V2 = `main:
  steps:
    - done:
        return: world
`;

const waitUntilGone = (name: string) =>
  workflows.getProjectsLocationsWorkflows({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilSucceeded = (name: string) =>
  workflowexecutions.getProjectsLocationsWorkflowsExecutions({ name }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (execution) =>
        execution.state === "SUCCEEDED" ||
        execution.state === "FAILED" ||
        execution.state === "CANCELLED",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a workflow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Workflows.Workflow("Greet", {
            location: "us-central1",
            description: "greet",
            labels: { env: "test" },
            sourceContents: SOURCE_V1,
          });
        }),
      );

      expect(created.workflowId).toEqual(expect.any(String));
      expect(created.name).toContain("/workflows/");
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("greet");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("ACTIVE");
      expect(created.sourceContents).toContain("hello");
      expect(created.revisionId).toEqual(expect.any(String));

      const fetched = yield* workflows.getProjectsLocationsWorkflows({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("greet");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.state).toEqual("ACTIVE");
      expect(fetched.sourceContents).toContain("hello");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const listed = yield* workflows.listProjectsLocationsWorkflows({
        parent: `projects/${created.project}/locations/${created.location}`,
      });
      expect(
        (listed.workflows ?? []).some(
          (workflow) => workflow.name === created.name,
        ),
      ).toEqual(true);

      const execution =
        yield* workflowexecutions.createProjectsLocationsWorkflowsExecutions({
          parent: created.name,
          body: {},
        });
      expect(execution.name).toEqual(expect.any(String));
      const finished = yield* waitUntilSucceeded(execution.name!);
      expect(finished.state).toEqual("SUCCEEDED");
      expect(finished.result).toContain("hello");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Workflows.Workflow("Greet", {
            workflowId: created.workflowId,
            location: "us-central1",
            description: "greet v2",
            labels: { env: "prod", role: "greeter" },
            callLogLevel: "LOG_ERRORS_ONLY",
            userEnvVars: { greeting: "world" },
            sourceContents: SOURCE_V2,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.workflowId).toEqual(created.workflowId);
      expect(updated.description).toEqual("greet v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "greeter" });
      expect(updated.callLogLevel).toEqual("LOG_ERRORS_ONLY");
      expect(updated.userEnvVars).toMatchObject({ greeting: "world" });
      expect(updated.sourceContents).toContain("world");
      expect(updated.revisionId).not.toEqual(created.revisionId);
      expect(updated.state).toEqual("ACTIVE");

      const fetchedUpdate = yield* workflows.getProjectsLocationsWorkflows({
        name: updated.name,
      });
      expect(fetchedUpdate.description).toEqual("greet v2");
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("greeter");
      expect(fetchedUpdate.callLogLevel).toEqual("LOG_ERRORS_ONLY");
      expect(fetchedUpdate.userEnvVars?.greeting).toEqual("world");
      expect(fetchedUpdate.sourceContents).toContain("world");
      expect(fetchedUpdate.state).toEqual("ACTIVE");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Workflows.Workflow("Greet", {
            workflowId: created.workflowId,
            location: "us-east1",
            description: "greet east",
            labels: { env: "test" },
            sourceContents: SOURCE_V1,
          });
        }),
      );

      expect(replaced.workflowId).toEqual(created.workflowId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/");
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.state).toEqual("ACTIVE");

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      const fetchedReplace = yield* workflows.getProjectsLocationsWorkflows({
        name: replaced.name,
      });
      expect(fetchedReplace.name).toEqual(replaced.name);
      expect(fetchedReplace.state).toEqual("ACTIVE");
      expect(fetchedReplace.sourceContents).toContain("hello");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workflows", "live"],
    timeout: 120_000,
  },
);
