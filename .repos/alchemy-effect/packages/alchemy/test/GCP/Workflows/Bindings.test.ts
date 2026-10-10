import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import WorkflowsBindingsHost, { Greet } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "WorkflowsBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let workflowName: string;

describe.skipIf(!dockerAvailable)(
  "Workflows Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:workflows",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* WorkflowsBindingsHost;
            const workflow = yield* Greet;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              name: workflow.name,
              project: workflow.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        workflowName = out.name;
        project = out.project;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("CreateExecution", () => {
      test.provider(
        "starts a run as the host's service account, granted workflows.invoker on the project",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* expectProbe<workflowexecutions.Execution>(
              baseUrl,
              "createExecution",
            );
            // Execution names carry the project number, not its id.
            const workflowPath = workflowName.slice(
              workflowName.indexOf("/locations/"),
            );
            expect(started.name).toEqual(
              expect.stringContaining(`${workflowPath}/executions/`),
            );

            const finished = yield* workflowexecutions
              .getProjectsLocationsWorkflowsExecutions({
                name: started.name ?? "",
              })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("2 seconds"),
                  until: (execution) => execution.state !== "ACTIVE",
                  times: 30,
                }),
              );
            expect(finished.state).toEqual("SUCCEEDED");
            expect(finished.result).toEqual(JSON.stringify("hello alchemy"));

            // Workflows has no per-workflow IAM policy: the binding grants
            // roles/workflows.invoker on the project.
            const policy = yield* crm.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => ({
                role: binding.role,
                condition: binding.condition,
              }));
            expect(roles).toEqual([
              { role: "roles/workflows.invoker", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workflows", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
