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

// Evaluators need an existing evaluation metric; a missing one fails with
// BadRequest "Request contains an invalid argument." Set
// GCP_TEST_AIPLATFORM_EVALUATION_METRIC to a metric resource name to run
// the lifecycle.
const evaluationMetric = process.env.GCP_TEST_AIPLATFORM_EVALUATION_METRIC;
const runLifecycle = !process.env.FAST && !!evaluationMetric;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsOnlineEvaluators({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsOnlineEvaluators on a missing evaluator fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsOnlineEvaluators({
          name: `${parent}/onlineEvaluators/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsOnlineEvaluators({
        parent,
        pageSize: 10,
      });
      expect(
        (page.onlineEvaluators ?? []).map((item) => item.name),
      ).not.toContain(`${parent}/onlineEvaluators/1234567890123456789`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an online evaluator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            location: "us-central1",
            displayName: "alchemy-eval-engine",
            description: "test",
            labels: { env: "test" },
            spec: { agentFramework: "custom" },
          });
          const evaluator = yield* GCP.AIPlatform.OnlineEvaluator("Quality", {
            location: "us-central1",
            displayName: "alchemy-online-eval",
            agentResource: engine.name,
            metricSources: [
              {
                metricResourceName: evaluationMetric,
              },
            ],
            config: { randomSampling: { percentage: 10 } },
          });
          return { engine, evaluator };
        }),
      );

      expect(created.evaluator.name).toContain("/onlineEvaluators/");
      expect(created.evaluator.location).toEqual("us-central1");
      expect(created.evaluator.displayName).toEqual("alchemy-online-eval");

      const fetched = yield* aiplatform.getProjectsLocationsOnlineEvaluators({
        name: created.evaluator.name,
      });
      expect(fetched.name).toEqual(created.evaluator.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            reasoningEngineId: created.engine.reasoningEngineId,
            location: "us-central1",
            displayName: "alchemy-eval-engine",
            description: "test",
            labels: { env: "test" },
            spec: { agentFramework: "custom" },
          });
          const evaluator = yield* GCP.AIPlatform.OnlineEvaluator("Quality", {
            location: "us-central1",
            displayName: "alchemy-online-eval-v2",
            agentResource: engine.name,
            metricSources: [
              {
                metricResourceName: evaluationMetric,
              },
            ],
            config: { randomSampling: { percentage: 20 } },
          });
          return { engine, evaluator };
        }),
      );

      expect(updated.evaluator.name).toEqual(created.evaluator.name);
      expect(updated.evaluator.displayName).toEqual("alchemy-online-eval-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.evaluator.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
