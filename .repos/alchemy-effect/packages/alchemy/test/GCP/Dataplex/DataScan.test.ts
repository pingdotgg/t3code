import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Output from "@/Output";
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

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsDataScans({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataScans on a missing scan fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataplex.getProjectsLocationsDataScans({
          name: `projects/${project}/locations/us-central1/dataScans/alchemy-missing-scan`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data scan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("ScanData", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("Orders", {
            datasetId: dataset.datasetId,
            schema: [{ name: "id", type: "STRING" }],
          });
          return yield* GCP.Dataplex.DataScan("OrdersProfile", {
            location: "us-central1",
            displayName: "orders profile",
            description: "scan a",
            labels: { env: "test" },
            data: {
              resource: Output.interpolate`//bigquery.googleapis.com/projects/${table.project}/datasets/${table.datasetId}/tables/${table.tableId}`,
            },
            dataProfileSpec: { samplingPercent: 100 },
          });
        }),
      );

      expect(created.name).toContain("/dataScans/");
      expect(created.dataScanId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("orders profile");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsDataScans({
        name: created.name,
        view: "FULL",
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("ScanData", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("Orders", {
            datasetId: dataset.datasetId,
            schema: [{ name: "id", type: "STRING" }],
          });
          return yield* GCP.Dataplex.DataScan("OrdersProfile", {
            dataScanId: created.dataScanId,
            location: "us-central1",
            displayName: "orders profile prod",
            description: "scan b",
            labels: { env: "prod", team: "data" },
            data: {
              resource: Output.interpolate`//bigquery.googleapis.com/projects/${table.project}/datasets/${table.datasetId}/tables/${table.tableId}`,
            },
            dataProfileSpec: { samplingPercent: 50 },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("orders profile prod");
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
