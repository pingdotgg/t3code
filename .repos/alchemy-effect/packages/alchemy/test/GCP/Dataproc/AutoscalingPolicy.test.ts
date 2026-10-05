import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  dataproc.getProjectsLocationsAutoscalingPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAutoscalingPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataproc.getProjectsLocationsAutoscalingPolicies({
          name: `projects/${project}/locations/us-central1/autoscalingPolicies/alchemy-dataproc-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete an autoscaling policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.AutoscalingPolicy("SparkScale", {
            location: "us-central1",
            workerConfig: { minInstances: 2, maxInstances: 3 },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/autoscalingPolicies/");
      expect(created.policyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.workerMaxInstances).toEqual(3);

      const fetched = yield* dataproc.getProjectsLocationsAutoscalingPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.workerConfig?.maxInstances).toEqual(3);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.AutoscalingPolicy("SparkScale", {
            policyId: created.policyId,
            location: "us-central1",
            workerConfig: { minInstances: 2, maxInstances: 4 },
            labels: { env: "prod", role: "scale" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.workerMaxInstances).toEqual(4);
      expect(updated.labels).toMatchObject({ env: "prod", role: "scale" });

      const refetched = yield* dataproc.getProjectsLocationsAutoscalingPolicies(
        {
          name: created.name,
        },
      );
      expect(refetched.workerConfig?.maxInstances).toEqual(4);
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);
