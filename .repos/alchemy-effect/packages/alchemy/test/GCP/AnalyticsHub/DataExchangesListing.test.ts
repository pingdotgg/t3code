import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as analyticshub from "@distilled.cloud/gcp/analyticshub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hubLocation,
  logLevel,
  currentProject,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (parent: string, name: string) =>
  analyticshub
    .listProjectsLocationsDataExchangesListings({ parent, pageSize: 100 })
    .pipe(
      Effect.map((page) =>
        (page.listings ?? []).some((item) => item.name === name)
          ? ("found" as const)
          : ("gone" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("InternalServerError", () =>
        Effect.succeed("found" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 20,
      }),
    );

test.provider(
  "getProjectsLocationsDataExchangesListings on a missing listing fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        analyticshub.getProjectsLocationsDataExchangesListings({
          name: `projects/${project}/locations/${hubLocation}/dataExchanges/missing/listings/alchemy_missing_listing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:analyticshub", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "listing lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Source", {
            location: hubLocation,
            forceDestroy: true,
          });
          const exchange = yield* GCP.AnalyticsHub.DataExchange("Hub", {
            location: hubLocation,
            displayName: "Hub",
          });
          const listing = yield* GCP.AnalyticsHub.DataExchangesListing(
            "Orders",
            {
              dataExchange: exchange.name,
              location: hubLocation,
              displayName: "Orders",
              description: "order events",
              bigqueryDataset: { dataset: dataset.name },
            },
          );
          return { dataset, exchange, listing };
        }),
      );

      expect(created.listing.name).toContain("/listings/");
      expect(created.listing.dataExchange).toEqual(created.exchange.name);
      expect(created.listing.displayName).toEqual("Orders");
      expect(created.listing.description).toEqual("order events");
      expect(created.listing.bigqueryDataset?.dataset).toContain(
        created.dataset.datasetId,
      );

      const fetched =
        yield* analyticshub.getProjectsLocationsDataExchangesListings({
          name: created.listing.name,
        });
      expect(fetched.name).toEqual(created.listing.name);
      expect(fetched.displayName).toEqual("Orders");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("order events");
      expect(fetched.bigqueryDataset?.dataset).toContain(
        created.dataset.datasetId,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Source", {
            datasetId: created.dataset.datasetId,
            location: hubLocation,
            forceDestroy: true,
          });
          const exchange = yield* GCP.AnalyticsHub.DataExchange("Hub", {
            dataExchangeId: created.exchange.dataExchangeId,
            location: hubLocation,
            displayName: "Hub",
          });
          const listing = yield* GCP.AnalyticsHub.DataExchangesListing(
            "Orders",
            {
              dataExchange: exchange.name,
              listingId: created.listing.listingId,
              location: hubLocation,
              displayName: "Orders v2",
              description: "order facts",
              primaryContact: "orders@example.com",
              bigqueryDataset: { dataset: dataset.name },
            },
          );
          return { dataset, exchange, listing };
        }),
      );

      expect(updated.listing.name).toEqual(created.listing.name);
      expect(updated.listing.displayName).toEqual("Orders v2");
      expect(updated.listing.description).toEqual("order facts");
      expect(updated.listing.primaryContact).toEqual("orders@example.com");

      const fetchedUpdate =
        yield* analyticshub.getProjectsLocationsDataExchangesListings({
          name: created.listing.name,
        });
      expect(fetchedUpdate.displayName).toEqual("Orders v2");
      expect(fetchedUpdate.description).toContain("order facts");
      expect(fetchedUpdate.primaryContact).toEqual("orders@example.com");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.exchange.name,
        created.listing.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:analyticshub", "live"],
    timeout: 120_000,
  },
);
