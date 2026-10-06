import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
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

const LOCATION = "us-central1";

const waitUntilGone = (name: string) =>
  bqdt.getProjectsLocationsTransferConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTransferConfigs on a missing config fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bqdt.getProjectsLocationsTransferConfigs({
          name: `projects/${project}/locations/${LOCATION}/transferConfigs/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigquerydatatransfer", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a transfer config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.BigQueryDataTransfer.TransferConfig("Nightly", {
            location: "us-central1",
            dataSourceId: "scheduled_query",
            destinationDatasetId: dataset.datasetId,
            displayName: "nightly",
            schedule: "every 24 hours",
            scheduleOptions: { disableAutoScheduling: true },
            params: {
              query: "SELECT 1 AS n",
              destination_table_name_template: "nightly",
              write_disposition: "WRITE_TRUNCATE",
            },
          });
        }),
      );

      expect(created.name).toContain("/transferConfigs/");
      expect(created.transferConfigId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.dataSourceId).toEqual("scheduled_query");
      expect(created.displayName).toEqual("nightly");
      expect(created.disabled).toEqual(false);
      expect(created.scheduleOptions?.disableAutoScheduling).toEqual(true);
      expect(created.params).toMatchObject({
        query: "SELECT 1 AS n",
        destination_table_name_template: "nightly",
        write_disposition: "WRITE_TRUNCATE",
      });

      const fetched = yield* bqdt.getProjectsLocationsTransferConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.dataSourceId).toEqual("scheduled_query");
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("nightly");
      expect(fetched.scheduleOptions?.disableAutoScheduling).toEqual(true);
      expect(fetched.params).toMatchObject({
        query: "SELECT 1 AS n",
        destination_table_name_template: "nightly",
      });

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.BigQueryDataTransfer.TransferConfig("Nightly", {
            location: "us-central1",
            dataSourceId: "scheduled_query",
            destinationDatasetId: dataset.datasetId,
            displayName: "nightly v2",
            schedule: "every 12 hours",
            scheduleOptions: { disableAutoScheduling: true },
            disabled: true,
            params: {
              query: "SELECT 2 AS n",
              destination_table_name_template: "nightly",
              write_disposition: "WRITE_TRUNCATE",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.transferConfigId).toEqual(created.transferConfigId);
      expect(updated.displayName).toEqual("nightly v2");
      expect(updated.disabled).toEqual(true);
      expect(updated.scheduleOptions?.disableAutoScheduling).toEqual(true);
      expect(updated.params).toMatchObject({ query: "SELECT 2 AS n" });

      const fetchedUpdate = yield* bqdt.getProjectsLocationsTransferConfigs({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toContain("nightly v2");
      expect(fetchedUpdate.disabled).toEqual(true);
      expect(fetchedUpdate.params).toMatchObject({ query: "SELECT 2 AS n" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigquerydatatransfer", "live"],
    timeout: 120_000,
  },
);
