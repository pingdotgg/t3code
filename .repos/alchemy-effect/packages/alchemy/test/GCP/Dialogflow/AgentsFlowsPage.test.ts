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
  dialogflow.getProjectsLocationsAgentsFlowsPages({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsFlowsPages on a missing page fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsFlowsPages({
          name: `projects/${project}/locations/global/agents/alchemy-missing/flows/alchemy-missing/pages/alchemy-missing`,
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
  "create, update, and delete a flow page",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const agent = yield* ensureAgent(project, "alchemy-df-page");

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const flow = yield* GCP.Dialogflow.AgentsFlow("Main", {
              agent: agent.name ?? "",
              displayName: "main",
            });
            const page = yield* GCP.Dialogflow.AgentsFlowsPage("Greeting", {
              flow: flow.name,
              displayName: "greeting",
              description: "welcome the user",
            });
            return { flow, page };
          }),
        );

        expect(created.page.name).toContain("/pages/");
        expect(created.page.displayName).toEqual("greeting");
        expect(created.page.description).toEqual("welcome the user");

        const fetched = yield* dialogflow.getProjectsLocationsAgentsFlowsPages({
          name: created.page.name,
        });
        expect(fetched.name).toEqual(created.page.name);
        expect(fetched.description).toContain("[alchemy ");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const flow = yield* GCP.Dialogflow.AgentsFlow("Main", {
              agent: agent.name ?? "",
              flowId: created.flow.flowId,
              displayName: "main",
            });
            const page = yield* GCP.Dialogflow.AgentsFlowsPage("Greeting", {
              flow: flow.name,
              pageId: created.page.pageId,
              displayName: "welcome",
              description: "welcome page",
            });
            return { flow, page };
          }),
        );

        expect(updated.page.name).toEqual(created.page.name);
        expect(updated.page.displayName).toEqual("welcome");
        expect(updated.page.description).toEqual("welcome page");

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.page.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);
