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
const agentDisplayName = "alch-df-pv";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsPlaybooksVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsPlaybooksVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsPlaybooksVersions({
          name: `projects/${project}/locations/global/agents/missing/playbooks/missing/versions/999999`,
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
  "create and delete a playbook version",
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
            displayName: "support-pv",
            goal: "Greet the user.",
          });
          const version = yield* GCP.Dialogflow.AgentsPlaybooksVersion("v1", {
            playbook: playbook.name,
            description: "initial",
          });
          return { playbook, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.playbook).toEqual(created.playbook.name);
      expect(created.version.description).toEqual("initial");

      const fetched =
        yield* dialogflow.getProjectsLocationsAgentsPlaybooksVersions({
          name: created.version.name,
        });
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
