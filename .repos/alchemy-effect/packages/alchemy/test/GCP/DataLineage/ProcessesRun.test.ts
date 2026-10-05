import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datalineage from "@distilled.cloud/gcp/datalineage_v1";
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
  datalineage.getProjectsLocationsProcessesRuns({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a lineage run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const process = yield* GCP.DataLineage.Process("Etl", {
            location: "us-central1",
            displayName: "run parent",
            attributes: { env: "test" },
          });
          const run = yield* GCP.DataLineage.ProcessesRun("Nightly", {
            process: process.name,
            startTime: "2024-01-01T00:00:00Z",
            state: "STARTED",
            displayName: "nightly a",
            attributes: { env: "test" },
          });
          return { process, run };
        }),
      );

      expect(created.run.name).toContain("/runs/");
      expect(created.run.runId).toEqual(expect.any(String));
      expect(created.run.process).toEqual(created.process.name);
      expect(created.run.state).toEqual("STARTED");
      expect(created.run.displayName).toEqual("nightly a");
      expect(created.run.attributes).toMatchObject({ env: "test" });

      const fetched = yield* datalineage.getProjectsLocationsProcessesRuns({
        name: created.run.name,
      });
      expect(fetched.name).toEqual(created.run.name);
      expect(fetched.state).toEqual("STARTED");
      expect(
        Object.keys(fetched.attributes ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const process = yield* GCP.DataLineage.Process("Etl", {
            processId: created.process.processId,
            location: "us-central1",
            displayName: "run parent",
            attributes: { env: "test" },
          });
          const run = yield* GCP.DataLineage.ProcessesRun("Nightly", {
            process: process.name,
            runId: created.run.runId,
            startTime: "2024-01-01T00:00:00Z",
            endTime: "2024-01-01T01:00:00Z",
            state: "COMPLETED",
            displayName: "nightly b",
            attributes: { env: "prod" },
          });
          return { process, run };
        }),
      );

      expect(updated.run.name).toEqual(created.run.name);
      expect(updated.run.state).toEqual("COMPLETED");
      expect(updated.run.endTime).toBeDefined();
      expect(updated.run.displayName).toEqual("nightly b");
      expect(updated.run.attributes).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.run.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalineage", "live"],
    timeout: 90_000,
  },
);
