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
const agentDisplayName = "alch-df-ex";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsPlaybooksExamples({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsPlaybooksExamples on a missing example fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsPlaybooksExamples({
          name: `projects/${project}/locations/global/agents/missing/playbooks/missing/examples/missing`,
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
  "create, update, and delete a playbook example",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName);
      const agentName = agent.name ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const playbook = yield* GCP.Dialogflow.AgentsPlaybook("Support", {
            agent: agentName,
            displayName: "support-ex",
            goal: "Greet the user.",
          });
          const example = yield* GCP.Dialogflow.AgentsPlaybooksExample(
            "Hello",
            {
              playbook: playbook.name,
              displayName: "hello",
              conversationState: "OUTPUT_STATE_OK",
              actions: [
                { userUtterance: { text: "hello" } },
                { agentUtterance: { text: "Hi, how can I help?" } },
              ],
            },
          );
          return { playbook, example };
        }),
      );

      expect(created.example.name).toContain("/examples/");
      expect(created.example.playbook).toEqual(created.playbook.name);
      expect(created.example.displayName).toEqual("hello");

      const fetched =
        yield* dialogflow.getProjectsLocationsAgentsPlaybooksExamples({
          name: created.example.name,
        });
      expect(fetched.name).toEqual(created.example.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const playbook = yield* GCP.Dialogflow.AgentsPlaybook("Support", {
            agent: agentName,
            playbookId: created.playbook.playbookId,
            displayName: "support-ex",
            goal: "Greet the user.",
          });
          const example = yield* GCP.Dialogflow.AgentsPlaybooksExample(
            "Hello",
            {
              playbook: playbook.name,
              exampleId: created.example.exampleId,
              displayName: "hello",
              conversationState: "OUTPUT_STATE_OK",
              actions: [
                { userUtterance: { text: "hi" } },
                { agentUtterance: { text: "Hello there." } },
              ],
            },
          );
          return { playbook, example };
        }),
      );

      expect(updated.example.name).toEqual(created.example.name);
      expect(updated.example.actions?.[0]?.userUtterance?.text).toEqual("hi");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.example.name);
      expect(gone).toEqual("gone");

      yield* deleteAgent(agentName);
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);
