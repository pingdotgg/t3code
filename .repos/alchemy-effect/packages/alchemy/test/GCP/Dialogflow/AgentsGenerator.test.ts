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
const agentDisplayName = "alch-df-gen";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsGenerators({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsGenerators on a missing generator fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsGenerators({
          name: `projects/${project}/locations/global/agents/missing/generators/missing`,
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
  "create, update, and delete a generator",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName);
      const agentName = agent.name ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsGenerator("Greeting", {
            agent: agentName,
            displayName: "greeting",
            promptText: "Greet the user by name.",
          });
        }),
      );

      expect(created.name).toContain("/generators/");
      expect(created.agent).toEqual(agentName);
      expect(created.displayName).toEqual("greeting");
      expect(created.promptText).toEqual("Greet the user by name.");

      const fetched = yield* dialogflow.getProjectsLocationsAgentsGenerators({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsGenerator("Greeting", {
            agent: agentName,
            generatorId: created.generatorId,
            displayName: "greeting",
            promptText: "Greet the user warmly.",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.promptText).toEqual("Greet the user warmly.");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");

      yield* deleteAgent(agentName);
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);
