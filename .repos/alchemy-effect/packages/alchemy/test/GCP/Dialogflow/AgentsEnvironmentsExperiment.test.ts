import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { deleteAgent, ensureAgent, quotaTolerant } from "./parent.ts";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsEnvironmentsExperiments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsEnvironmentsExperiments on a missing experiment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsEnvironmentsExperiments({
          name: `projects/${project}/locations/global/agents/alchemy-missing/environments/alchemy-missing/experiments/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an experiment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const agent = yield* ensureAgent(project, "alchemy-df-experiment");
      const startFlow = agent.startFlow ?? "";

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const control = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: startFlow,
              displayName: "control",
              description: "control snapshot",
            });
            const treatment = yield* GCP.Dialogflow.AgentsFlowsVersion("V2", {
              flow: startFlow,
              displayName: "treatment",
              description: control.versionId,
            });
            const environment = yield* GCP.Dialogflow.AgentsEnvironment(
              "Prod",
              {
                agent: agent.name ?? "",
                displayName: "prod",
                versionConfigs: [{ version: control.name }],
              },
            );
            const experiment =
              yield* GCP.Dialogflow.AgentsEnvironmentsExperiment("Ab", {
                environment: environment.name,
                displayName: "checkout-ab",
                description: "ab test",
                definition: {
                  versionVariants: {
                    variants: [
                      {
                        version: control.name,
                        trafficAllocation: 0.5,
                        isControlGroup: true,
                      },
                      {
                        version: treatment.name,
                        trafficAllocation: 0.5,
                      },
                    ],
                  },
                },
              });
            return { control, treatment, environment, experiment };
          }),
        );

        expect(created.experiment.name).toContain("/experiments/");
        expect(created.experiment.displayName).toEqual("checkout-ab");
        expect(created.experiment.description).toEqual("ab test");

        const fetched =
          yield* dialogflow.getProjectsLocationsAgentsEnvironmentsExperiments({
            name: created.experiment.name,
          });
        expect(fetched.name).toEqual(created.experiment.name);
        expect(fetched.description).toContain("[alchemy ");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const control = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: startFlow,
              versionId: created.control.versionId,
              displayName: "control",
              description: "control snapshot",
            });
            const treatment = yield* GCP.Dialogflow.AgentsFlowsVersion("V2", {
              flow: startFlow,
              versionId: created.treatment.versionId,
              displayName: "treatment",
              description: control.versionId,
            });
            const environment = yield* GCP.Dialogflow.AgentsEnvironment(
              "Prod",
              {
                agent: agent.name ?? "",
                environmentId: created.environment.environmentId,
                displayName: "prod",
                versionConfigs: [{ version: control.name }],
              },
            );
            const experiment =
              yield* GCP.Dialogflow.AgentsEnvironmentsExperiment("Ab", {
                environment: environment.name,
                experimentId: created.experiment.experimentId,
                displayName: "checkout-ab-v2",
                description: "ab test v2",
                definition: {
                  versionVariants: {
                    variants: [
                      {
                        version: control.name,
                        trafficAllocation: 0.5,
                        isControlGroup: true,
                      },
                      {
                        version: treatment.name,
                        trafficAllocation: 0.5,
                      },
                    ],
                  },
                },
              });
            return { control, treatment, environment, experiment };
          }),
        );

        expect(updated.experiment.name).toEqual(created.experiment.name);
        expect(updated.experiment.displayName).toEqual("checkout-ab-v2");
        expect(updated.experiment.description).toEqual("ab test v2");

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.experiment.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);
