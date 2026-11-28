import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/unstable/aiplatform_v1beta1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// AgentService serves only v1beta1. The lifecycle test creates a real agent;
// set GCP_TEST_AIPLATFORM_AGENTS=1 to run it.
const runLifecycle = !process.env.FAST && !!process.env.GCP_TEST_AIPLATFORM_AGENTS;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsAgents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAgents on a missing agent fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/global`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsAgents({
          name: `${parent}/agents/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a vertex agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Agent("Support", {
            systemInstruction: "Answer briefly.",
            metadata: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/agents/");
      expect(created.location).toEqual("global");
      expect(created.metadata).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsAgents({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Agent("Support", {
            agentId: created.agentId,
            systemInstruction: "Answer in one sentence.",
            metadata: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.systemInstruction).toEqual("Answer in one sentence.");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
