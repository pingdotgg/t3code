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

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsReasoningEnginesMemories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsReasoningEnginesMemories on a missing memory fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsReasoningEnginesMemories({
          name: `projects/${project}/locations/us-central1/reasoningEngines/1234567890123456789/memories/1234567890123456789`,
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

test.provider(
  "create, update, and delete a reasoning engine memory",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            location: "us-central1",
            displayName: "alchemy-memory-engine",
            description: "test",
            labels: { env: "test" },
            spec: { agentFramework: "custom" },
          });
          const memory = yield* GCP.AIPlatform.ReasoningEnginesMemory("Pref", {
            reasoningEngine: engine.name,
            location: "us-central1",
            scope: { user_id: "alchemy-user" },
            fact: "the user prefers concise answers",
            displayName: "user-pref",
            description: "first",
          });
          return { engine, memory };
        }),
      );

      expect(created.memory.name).toContain("/memories/");
      expect(created.memory.reasoningEngine).toEqual(created.engine.name);
      expect(created.memory.fact).toEqual("the user prefers concise answers");

      const fetched =
        yield* aiplatform.getProjectsLocationsReasoningEnginesMemories({
          name: created.memory.name,
        });
      expect(fetched.name).toEqual(created.memory.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            reasoningEngineId: created.engine.reasoningEngineId,
            location: "us-central1",
            displayName: "alchemy-memory-engine",
            description: "test",
            labels: { env: "test" },
            spec: { agentFramework: "custom" },
          });
          const memory = yield* GCP.AIPlatform.ReasoningEnginesMemory("Pref", {
            reasoningEngine: engine.name,
            memoryId: created.memory.memoryId,
            location: "us-central1",
            scope: { user_id: "alchemy-user" },
            fact: "the user prefers detailed answers",
            displayName: "user-pref",
            description: "second",
          });
          return { engine, memory };
        }),
      );

      expect(updated.memory.name).toEqual(created.memory.name);
      expect(updated.memory.fact).toEqual("the user prefers detailed answers");
      expect(updated.memory.description).toEqual("second");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.memory.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
