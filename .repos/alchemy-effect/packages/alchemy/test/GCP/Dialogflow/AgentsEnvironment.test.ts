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
  dialogflow.getProjectsLocationsAgentsEnvironments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsEnvironments on a missing environment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsEnvironments({
          name: `projects/${project}/locations/global/agents/alchemy-missing/environments/alchemy-missing`,
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
  "create, update, and delete an environment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const agent = yield* ensureAgent(project, "alchemy-df-environment");
      const startFlow = agent.startFlow ?? "";

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: startFlow,
              displayName: "v1",
              description: "env snapshot",
            });
            const environment = yield* GCP.Dialogflow.AgentsEnvironment(
              "Prod",
              {
                agent: agent.name ?? "",
                displayName: "prod",
                description: "production",
                versionConfigs: [{ version: version.name }],
              },
            );
            return { version, environment };
          }),
        );

        expect(created.environment.name).toContain("/environments/");
        expect(created.environment.displayName).toEqual("prod");
        expect(created.environment.description).toEqual("production");
        expect(created.environment.versionConfigs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ version: created.version.name }),
          ]),
        );

        const fetched =
          yield* dialogflow.getProjectsLocationsAgentsEnvironments({
            name: created.environment.name,
          });
        expect(fetched.name).toEqual(created.environment.name);
        expect(fetched.description).toContain("[alchemy ");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const version = yield* GCP.Dialogflow.AgentsFlowsVersion("V1", {
              flow: startFlow,
              versionId: created.version.versionId,
              displayName: "v1",
              description: "env snapshot",
            });
            const environment = yield* GCP.Dialogflow.AgentsEnvironment(
              "Prod",
              {
                agent: agent.name ?? "",
                environmentId: created.environment.environmentId,
                displayName: "staging",
                description: "staging env",
                versionConfigs: [{ version: version.name }],
              },
            );
            return { version, environment };
          }),
        );

        expect(updated.environment.name).toEqual(created.environment.name);
        expect(updated.environment.displayName).toEqual("staging");
        expect(updated.environment.description).toEqual("staging env");

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.environment.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);
