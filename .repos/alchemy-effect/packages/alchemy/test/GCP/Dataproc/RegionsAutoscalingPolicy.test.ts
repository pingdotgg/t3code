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
  dataproc.getProjectsRegionsAutoscalingPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsRegionsAutoscalingPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataproc.getProjectsRegionsAutoscalingPolicies({
          name: `projects/${project}/regions/us-central1/autoscalingPolicies/alchemy-dataproc-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a regional autoscaling policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.RegionsAutoscalingPolicy("SparkScaleReg", {
            region: "us-central1",
            workerConfig: { minInstances: 2, maxInstances: 3 },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/regions/");
      expect(created.name).toContain("/autoscalingPolicies/");
      expect(created.region).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.workerMaxInstances).toEqual(3);

      const fetched = yield* dataproc.getProjectsRegionsAutoscalingPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.RegionsAutoscalingPolicy("SparkScaleReg", {
            policyId: created.policyId,
            region: "us-central1",
            workerConfig: { minInstances: 2, maxInstances: 5 },
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.workerMaxInstances).toEqual(5);
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);
