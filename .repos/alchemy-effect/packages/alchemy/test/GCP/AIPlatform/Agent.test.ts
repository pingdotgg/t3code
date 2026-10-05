import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// AgentService is v1beta1-only; the aiplatform_v1 SDK gets BadRequest
// "This API version is not supported by AgentService. Please use the
// v1beta1 version." Set GCP_TEST_AIPLATFORM_AGENTS=1 once the v1 API serves agents.
const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_AIPLATFORM_AGENTS;

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
  "getProjectsLocationsAgents on a missing agent fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsAgents({
          name: `${parent}/agents/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("AgentServiceV1Unsupported");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsAgents is rejected on the v1 API",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const error = yield* Effect.flip(
        aiplatform.createProjectsLocationsAgents({
          parent: `projects/${project}/locations/us-central1`,
          body: {},
        }),
      );
      expect(error._tag).toEqual("AgentServiceV1Unsupported");
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
            location: "us-central1",
            systemInstruction: "Answer briefly.",
            metadata: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/agents/");
      expect(created.location).toEqual("us-central1");
      expect(created.metadata).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsAgents({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Agent("Support", {
            agentId: created.agentId,
            location: "us-central1",
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
