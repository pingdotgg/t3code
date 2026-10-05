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
  dataplex.getProjectsLocationsDataProductsDataAssets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataProductsDataAssets on a missing asset fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataplex.getProjectsLocationsDataProductsDataAssets({
          name: `projects/${project}/locations/us-central1/dataProducts/alchemy-missing/dataAssets/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data product data asset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("ProductData", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const product = yield* GCP.Dataplex.DataProduct("Sales", {
            location: "us-central1",
            displayName: "Sales mart",
            ownerEmails: ["owner@example.com"],
            labels: { env: "test" },
          });
          return yield* GCP.Dataplex.DataProductsDataAsset("Orders", {
            parent: product.name,
            resource: Output.interpolate`//bigquery.googleapis.com/projects/${dataset.project}/datasets/${dataset.datasetId}`,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/dataAssets/");
      expect(created.dataAssetId).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.resource).toContain("/datasets/");

      const fetched =
        yield* dataplex.getProjectsLocationsDataProductsDataAssets({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("ProductData", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const product = yield* GCP.Dataplex.DataProduct("Sales", {
            location: "us-central1",
            displayName: "Sales mart",
            ownerEmails: ["owner@example.com"],
            labels: { env: "test" },
          });
          return yield* GCP.Dataplex.DataProductsDataAsset("Orders", {
            dataAssetId: created.dataAssetId,
            parent: product.name,
            resource: Output.interpolate`//bigquery.googleapis.com/projects/${dataset.project}/datasets/${dataset.datasetId}`,
            labels: { env: "prod", team: "data" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
