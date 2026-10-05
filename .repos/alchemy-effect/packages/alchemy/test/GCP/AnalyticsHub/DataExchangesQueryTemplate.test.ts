import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as analyticshub from "@distilled.cloud/gcp/analyticshub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hubLocation,
  logLevel,
  primaryContactOf,
  currentProject,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (parent: string, name: string) =>
  analyticshub
    .listProjectsLocationsDataExchangesQueryTemplates({
      parent,
      pageSize: 100,
    })
    .pipe(
      Effect.map((page) =>
        (page.queryTemplates ?? []).some((item) => item.name === name)
          ? ("found" as const)
          : ("gone" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsDataExchangesQueryTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        analyticshub.getProjectsLocationsDataExchangesQueryTemplates({
          name: `projects/${project}/locations/${hubLocation}/dataExchanges/missing/queryTemplates/alchemy_missing_template`,
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
  "query template lifecycle",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const primaryContact = primaryContactOf(project);

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const exchange = yield* GCP.AnalyticsHub.DataExchange("CleanRoom", {
            location: hubLocation,
            displayName: "Clean Room",
            sharingEnvironmentConfig: { dcrExchangeConfig: {} },
          });
          const template = yield* GCP.AnalyticsHub.DataExchangesQueryTemplate(
            "Counts",
            {
              dataExchange: exchange.name,
              location: hubLocation,
              displayName: "Counts",
              description: "row counts",
              primaryContact,
              routine: {
                routineType: "TABLE_VALUED_FUNCTION",
                definitionBody: "SELECT 1 AS n",
              },
            },
          );
          return { exchange, template };
        }),
      );

      expect(created.template.name).toContain("/queryTemplates/");
      expect(created.template.dataExchange).toEqual(created.exchange.name);
      expect(created.template.displayName).toEqual("Counts");
      expect(created.template.description).toEqual("row counts");
      expect(created.template.routine?.routineType).toEqual(
        "TABLE_VALUED_FUNCTION",
      );

      const fetched =
        yield* analyticshub.getProjectsLocationsDataExchangesQueryTemplates({
          name: created.template.name,
        });
      expect(fetched.name).toEqual(created.template.name);
      expect(fetched.displayName).toEqual("Counts");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("row counts");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const exchange = yield* GCP.AnalyticsHub.DataExchange("CleanRoom", {
            dataExchangeId: created.exchange.dataExchangeId,
            location: hubLocation,
            displayName: "Clean Room",
            sharingEnvironmentConfig: { dcrExchangeConfig: {} },
          });
          const template = yield* GCP.AnalyticsHub.DataExchangesQueryTemplate(
            "Counts",
            {
              dataExchange: exchange.name,
              queryTemplateId: created.template.queryTemplateId,
              location: hubLocation,
              displayName: "Counts",
              description: "updated counts",
              primaryContact,
              routine: {
                routineType: "TABLE_VALUED_FUNCTION",
                definitionBody: "SELECT 2 AS n",
              },
            },
          );
          return { exchange, template };
        }),
      );

      expect(updated.template.name).toEqual(created.template.name);
      expect(updated.template.displayName).toEqual("Counts");
      expect(updated.template.description).toEqual("updated counts");

      const fetchedUpdate =
        yield* analyticshub.getProjectsLocationsDataExchangesQueryTemplates({
          name: created.template.name,
        });
      expect(fetchedUpdate.displayName).toEqual("Counts");
      expect(fetchedUpdate.description).toContain("updated counts");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.exchange.name,
        created.template.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:analyticshub", "live"],
    timeout: 120_000,
  },
);
