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
  aiplatform.getProjectsLocationsReasoningEnginesSessions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsReasoningEnginesSessions on a missing session fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsReasoningEnginesSessions({
          name: `projects/${project}/locations/us-central1/reasoningEngines/1234567890123456789/sessions/1234567890123456789`,
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
  "create, update, and delete a reasoning engine session",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const engine = Effect.gen(function* () {
        return yield* GCP.AIPlatform.ReasoningEngine("Agent", {
          location: "us-central1",
          displayName: "alchemy-session-engine",
          spec: { agentFramework: "custom" },
        });
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { name: parent } = yield* engine;
          return yield* GCP.AIPlatform.ReasoningEnginesSession("Chat", {
            parent,
            userId: "alchemy-user",
            displayName: "support-chat",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/sessions/");
      expect(created.userId).toEqual("alchemy-user");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsReasoningEnginesSessions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { name: parent } = yield* engine;
          return yield* GCP.AIPlatform.ReasoningEnginesSession("Chat", {
            parent,
            sessionId: created.sessionId,
            userId: "alchemy-user",
            displayName: "support-chat-v2",
            labels: { env: "prod" },
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("support-chat-v2");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 300_000,
  },
);
