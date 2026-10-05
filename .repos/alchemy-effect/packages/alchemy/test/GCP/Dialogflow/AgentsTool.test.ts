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
const agentDisplayName = "alch-df-tool";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsTools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsTools on a missing tool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsTools({
          name: `projects/${project}/locations/global/agents/missing/tools/missing`,
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
  "create, update, and delete a tool",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName);
      const agentName = agent.name ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsTool("Lookup", {
            agent: agentName,
            displayName: "lookup",
            description: "Look up an order.",
            functionSpec: {
              inputSchema: {
                type: "object",
                properties: { orderId: { type: "string" } },
              },
              outputSchema: {
                type: "object",
                properties: { status: { type: "string" } },
              },
            },
          });
        }),
      );

      expect(created.name).toContain("/tools/");
      expect(created.agent).toEqual(agentName);
      expect(created.displayName).toEqual("lookup");
      expect(created.description).toEqual("Look up an order.");
      expect(created.functionSpec).toBeDefined();

      const fetched = yield* dialogflow.getProjectsLocationsAgentsTools({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsTool("Lookup", {
            agent: agentName,
            toolId: created.toolId,
            displayName: "lookup",
            description: "Look up an order by id.",
            functionSpec: {
              inputSchema: {
                type: "object",
                properties: {
                  orderId: { type: "string" },
                  includeHistory: { type: "boolean" },
                },
              },
              outputSchema: {
                type: "object",
                properties: { status: { type: "string" } },
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("Look up an order by id.");

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
