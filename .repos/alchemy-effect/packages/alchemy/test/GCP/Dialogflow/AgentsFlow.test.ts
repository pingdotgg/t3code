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
  dialogflow.getProjectsLocationsAgentsFlows({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgentsFlows on a missing flow fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsFlows({
          name: `projects/${project}/locations/global/agents/alchemy-missing/flows/alchemy-missing`,
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
  "create, update, and delete a flow",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const agent = yield* ensureAgent(project, "alchemy-df-flow");

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsFlow("Ordering", {
              agent: agent.name ?? "",
              displayName: "ordering",
              description: "order intake",
            });
          }),
        );

        expect(created.name).toContain("/flows/");
        expect(created.displayName).toEqual("ordering");
        expect(created.description).toEqual("order intake");

        const fetched = yield* dialogflow.getProjectsLocationsAgentsFlows({
          name: created.name,
        });
        expect(fetched.name).toEqual(created.name);
        expect(fetched.description).toContain("[alchemy ");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsFlow("Ordering", {
              agent: agent.name ?? "",
              flowId: created.flowId,
              displayName: "checkout",
              description: "checkout flow",
            });
          }),
        );

        expect(updated.name).toEqual(created.name);
        expect(updated.displayName).toEqual("checkout");
        expect(updated.description).toEqual("checkout flow");

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agent.name ?? "")));
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:dialogflow", "live"],
    timeout: 120_000,
  },
);
