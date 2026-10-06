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
const agentDisplayName = "alch-df-tv";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsToolsVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsToolsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsToolsVersions({
          name: `projects/${project}/locations/global/agents/missing/tools/missing/versions/999999`,
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
  "create and delete a tool version",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName);
      const agentName = agent.name ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const tool = yield* GCP.Dialogflow.AgentsTool("Lookup", {
            agent: agentName,
            displayName: "lookup-tv",
            description: "Look up an order.",
          });
          const version = yield* GCP.Dialogflow.AgentsToolsVersion("v1", {
            tool: tool.name,
            displayName: "initial",
          });
          return { tool, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.tool).toEqual(created.tool.name);
      expect(created.version.displayName).toEqual("initial");

      const fetched = yield* dialogflow.getProjectsLocationsAgentsToolsVersions(
        { name: created.version.name },
      );
      expect(fetched.name).toEqual(created.version.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");

      yield* deleteAgent(agentName);
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);
