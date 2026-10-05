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
  aiplatform.getProjectsLocationsReasoningEngines({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsReasoningEngines on a missing engine fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsReasoningEngines({
          name: `projects/${project}/locations/us-central1/reasoningEngines/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsReasoningEngines({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 10,
      });
      expect(
        (page.reasoningEngines ?? []).map((item) => item.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/reasoningEngines/1234567890123456789`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a reasoning engine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            location: "us-central1",
            displayName: "alchemy-test-engine",
            description: "test",
            labels: { env: "test" },
            spec: { agentFramework: "custom" },
          });
        }),
      );

      expect(created.name).toContain("/reasoningEngines/");
      expect(created.reasoningEngineId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("alchemy-test-engine");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsReasoningEngines({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.displayName).toEqual("alchemy-test-engine");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            reasoningEngineId: created.reasoningEngineId,
            location: "us-central1",
            displayName: "alchemy-prod-engine",
            description: "prod",
            labels: { env: "prod", role: "agent" },
            spec: { agentFramework: "custom" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-engine");
      expect(updated.labels).toMatchObject({ env: "prod", role: "agent" });

      const refetched = yield* aiplatform.getProjectsLocationsReasoningEngines({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-engine");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("agent");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
