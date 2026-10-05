import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsLakesTasks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const serviceAccountOf = GcpEnvironment.current.pipe(
  Effect.map(
    ({ project }) => `alchemy-testing@${project}.iam.gserviceaccount.com`,
  ),
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a lake task",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const serviceAccount = yield* serviceAccountOf;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const lake = yield* GCP.Dataplex.Lake("Warehouse", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const task = yield* GCP.Dataplex.LakesTask("SelectOne", {
            lake: lake.name,
            displayName: "select one",
            description: "on demand sql",
            labels: { env: "test" },
            triggerSpec: { type: "ON_DEMAND" },
            executionSpec: {
              serviceAccount,
              args: { output_location: "gs://dataplex-task-output/out" },
            },
            spark: { sqlScript: "SELECT 1" },
          });
          return { lake, task };
        }),
      );

      expect(created.task.name).toContain("/tasks/");
      expect(created.task.taskId).toEqual(expect.any(String));
      expect(created.task.lake).toEqual(created.lake.name);
      expect(created.task.triggerType).toEqual("ON_DEMAND");
      expect(created.task.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsLakesTasks({
        name: created.task.name,
      });
      expect(fetched.name).toEqual(created.task.name);
      expect(fetched.spark?.sqlScript).toEqual("SELECT 1");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const lake = yield* GCP.Dataplex.Lake("Warehouse", {
            lakeId: created.lake.lakeId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const task = yield* GCP.Dataplex.LakesTask("SelectOne", {
            lake: lake.name,
            taskId: created.task.taskId,
            displayName: "select two",
            description: "on demand sql b",
            labels: { env: "prod", team: "data" },
            triggerSpec: { type: "ON_DEMAND" },
            executionSpec: {
              serviceAccount,
              args: { output_location: "gs://dataplex-task-output/out" },
            },
            spark: { sqlScript: "SELECT 2" },
          });
          return { lake, task };
        }),
      );

      expect(updated.task.name).toEqual(created.task.name);
      expect(updated.task.displayName).toEqual("select two");
      expect(updated.task.description).toEqual("on demand sql b");
      expect(updated.task.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.task.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
