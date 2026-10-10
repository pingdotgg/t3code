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

// Each serverless workload reserves 12 vCPUs and hundreds of GB of Hyperdisk;
// next to the rest of the suite the testing project's quotas run out
// (`Quota 'HDB_TOTAL_GB' exceeded. Limit: 500.0 in region us-central1`,
// `Insufficient 'CPUS_ALL_REGIONS' quota`). Passes solo in ~2 minutes; set
// GCP_TEST_DATAPROC_SERVERLESS=1 on a project with headroom.
const runLifecycle =
  !!process.env.GCP_TEST_DATAPROC_SERVERLESS && !process.env.FAST;

const waitUntilGone = (name: string) =>
  dataproc.getProjectsLocationsBatches({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBatches on a missing batch fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataproc.getProjectsLocationsBatches({
          name: `projects/${project}/locations/us-central1/batches/alchemy-dataproc-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a spark batch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.Batch("Pi", {
            location: "us-central1",
            sparkBatch: {
              mainClass: "org.apache.spark.examples.SparkPi",
              jarFileUris: [
                "file:///usr/lib/spark/examples/jars/spark-examples.jar",
              ],
              args: ["1"],
            },
            environmentConfig: { executionConfig: { ttl: "600s" } },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/batches/");
      expect(created.batchId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual(expect.any(String));

      const fetched = yield* dataproc.getProjectsLocationsBatches({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.sparkBatch?.mainClass).toEqual(
        "org.apache.spark.examples.SparkPi",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 600_000 },
);
